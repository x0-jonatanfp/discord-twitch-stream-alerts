import WebSocket from "ws";
import type { StreamOnlineEvent } from "../../domain/entities/stream.js";
import type { LoggerPort } from "../../domain/ports/logger.js";
import type { TwitchStreamsPort } from "../../domain/ports/twitch-streams.js";

interface EventSubEnvelope {
  metadata?: { message_type?: string; message_id?: string; subscription_type?: string };
  payload?: {
    session?: { id?: string; reconnect_url?: string | null };
    event?: StreamOnlineEvent;
    subscription?: {
      status?: string;
      type?: string;
      condition?: { broadcaster_user_id?: string };
    };
  };
}

export interface EventSubClientOptions {
  broadcasterIds: string[];
  twitch: TwitchStreamsPort;
  onStreamOnline: (event: StreamOnlineEvent) => Promise<void>;
  onSessionReady?: () => Promise<void>;
  logger: LoggerPort;
  webSocketFactory?: (url: string) => WebSocket;
  keepaliveTimeoutMs?: number;
}

export class EventSubClient {
  private readonly sockets = new Set<WebSocket>();
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private keepaliveSocket: WebSocket | null = null;
  private currentSocket: WebSocket | null = null;
  private replacementSocket: WebSocket | null = null;
  private currentSessionId: string | null = null;
  private reconnectAttempts = 0;
  private readonly reconnectHandoverSockets = new WeakSet<WebSocket>();

  constructor(private readonly options: EventSubClientOptions) {}

  start(): void {
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.connect("wss://eventsub.wss.twitch.tv/ws", true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearKeepalive();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.currentSessionId = null;
    const sockets = [...this.sockets];
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000, "shutting down");
    })));
    this.sockets.clear();
    this.currentSocket = null;
    this.replacementSocket = null;
  }

  private connect(url: string, makeCurrent: boolean, isReconnectHandover = false): void {
    if (this.stopped) return;
    const socket = (this.options.webSocketFactory ?? ((socketUrl) => new WebSocket(socketUrl)))(url);
    this.sockets.add(socket);
    if (isReconnectHandover) this.reconnectHandoverSockets.add(socket);
    if (makeCurrent) this.currentSocket = socket;
    else this.replacementSocket = socket;
    this.resetKeepalive(socket);

    socket.on("message", (raw: WebSocket.RawData) => {
      this.resetKeepalive(socket);
      void this.handleMessage(socket, raw.toString());
    });
    socket.on("error", (error: Error) => {
      this.options.logger.error(`Twitch EventSub WebSocket error: ${error.message}`);
    });
    socket.on("close", (code: number) => {
      this.sockets.delete(socket);
      if (this.keepaliveSocket === socket) this.clearKeepalive();
      if (this.currentSocket === socket) this.currentSocket = null;
      if (this.replacementSocket === socket) this.replacementSocket = null;
      if (this.stopped) return;
      if (this.currentSocket && this.currentSocket !== socket) return;
      if (this.replacementSocket) return;
      this.options.logger.warn(`Twitch EventSub WebSocket closed (${code}); reconnecting`);
      this.scheduleReconnect();
    });
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let envelope: EventSubEnvelope;
    try {
      envelope = JSON.parse(raw) as EventSubEnvelope;
    } catch {
      this.options.logger.warn("Ignoring malformed Twitch EventSub message");
      return;
    }

    const messageType = envelope.metadata?.message_type;
    if (messageType === "session_welcome") {
      const sessionId = envelope.payload?.session?.id;
      if (!sessionId) {
        this.options.logger.error("Twitch EventSub welcome message did not contain a session ID");
        return;
      }
      this.currentSessionId = sessionId;
      this.reconnectAttempts = 0;
      this.options.logger.info("Connected to Twitch EventSub WebSocket");
      if (!this.reconnectHandoverSockets.has(socket)) await this.subscribeAll(sessionId);
      const oldSocket = this.replacementSocket === socket ? this.currentSocket : null;
      if (this.replacementSocket === socket) {
        this.currentSocket = socket;
        this.replacementSocket = null;
      } else if (!this.currentSocket) {
        this.currentSocket = socket;
      }
      if (oldSocket && oldSocket !== socket) oldSocket.close(1000, "new EventSub connection established");
      try {
        await this.options.onSessionReady?.();
      } catch (error) {
        this.options.logger.error(`Twitch EventSub startup reconciliation failed: ${errorMessage(error)}`);
      }
      return;
    }
    if (messageType === "session_reconnect") {
      const reconnectUrl = envelope.payload?.session?.reconnect_url;
      if (!reconnectUrl) {
        this.options.logger.error("Twitch EventSub reconnect message did not contain a reconnect URL");
        return;
      }
      if (this.replacementSocket) this.replacementSocket.close(1000, "superseded reconnect");
      this.connect(reconnectUrl, false, true);
      return;
    }
    if (messageType === "session_keepalive") return;
    if (messageType === "revocation") {
      const status = envelope.payload?.subscription?.status ?? "unknown";
      this.options.logger.error(`Twitch EventSub subscription revoked: ${status}`);
      const broadcasterId = envelope.payload?.subscription?.condition?.broadcaster_user_id;
      if (broadcasterId && this.currentSessionId) {
        void this.subscribeOne(broadcasterId, this.currentSessionId);
      } else if (this.currentSocket) {
        // Without the affected broadcaster, reconnect and subscribe to all.
        this.currentSocket.close(4000, "subscription revoked");
      }
      return;
    }
    if (messageType !== "notification" || envelope.metadata?.subscription_type !== "stream.online") return;
    const event = envelope.payload?.event;
    if (!event || (socket !== this.currentSocket && socket !== this.replacementSocket)) return;
    try {
      await this.options.onStreamOnline(event);
    } catch (error) {
      this.options.logger.error(`Failed to process Twitch stream event: ${errorMessage(error)}`);
    }
  }

  private async subscribeAll(sessionId: string): Promise<void> {
    for (const broadcasterId of this.options.broadcasterIds) {
      await this.subscribeOne(broadcasterId, sessionId);
    }
  }

  private async subscribeOne(broadcasterId: string, sessionId: string): Promise<void> {
    try {
      await this.options.twitch.subscribeToOnline(broadcasterId, sessionId);
    } catch (error) {
      this.options.logger.error(`Failed to subscribe to Twitch broadcaster ${broadcasterId}: ${errorMessage(error)}`);
    }
  }

  private resetKeepalive(socket: WebSocket): void {
    if (this.stopped) return;
    if (socket !== this.currentSocket && socket !== this.replacementSocket) return;
    this.clearKeepalive();
    this.keepaliveSocket = socket;
    const timer = setTimeout(() => {
      if (this.stopped || this.keepaliveSocket !== socket) return;
      this.keepaliveTimer = null;
      this.keepaliveSocket = null;
      this.options.logger.warn("Twitch EventSub keepalive timed out; reconnecting");
      socket.terminate();
    }, this.options.keepaliveTimeoutMs ?? 30_000);
    timer.unref();
    this.keepaliveTimer = timer;
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.keepaliveSocket = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect("wss://eventsub.wss.twitch.tv/ws", true);
    }, delay + Math.floor(Math.random() * 250));
    this.reconnectTimer.unref();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
