import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { EventSubClient } from "../src/infrastructure/twitch/eventsub-client.js";

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  close = vi.fn((code?: number) => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code ?? 1000);
  });
  message(payload: unknown): void {
    this.emit("message", Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
  }
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const onlineEvent = {
  id: "event-1", broadcaster_user_id: "broadcaster-1", broadcaster_user_login: "streamer", broadcaster_user_name: "Streamer",
  title: "Live", started_at: "2025-01-02T03:04:05Z",
};
function createClient() {
  const sockets: FakeWebSocket[] = [];
  const subscribeToOnline = vi.fn(async () => undefined);
  const onStreamOnline = vi.fn(async () => undefined);
  const onSessionReady = vi.fn(async () => undefined);
  const client = new EventSubClient({
    broadcasterIds: ["id-1", "id-2"],
    twitch: { subscribeToOnline, resolveChannels: vi.fn(), getLiveStreams: vi.fn() },
    onStreamOnline,
    onSessionReady,
    logger,
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { client, sockets, subscribeToOnline, onStreamOnline, onSessionReady };
}

describe("EventSubClient", () => {
  it("subscribes all broadcaster IDs when a new session welcomes", async () => {
    const f = createClient();
    f.client.start();
    f.sockets[0]?.message({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "session-1" } } });
    await vi.waitFor(() => expect(f.subscribeToOnline).toHaveBeenCalledTimes(2));
    expect(f.subscribeToOnline).toHaveBeenNthCalledWith(1, "id-1", "session-1");
    expect(f.subscribeToOnline).toHaveBeenNthCalledWith(2, "id-2", "session-1");
    expect(f.onSessionReady).toHaveBeenCalledOnce();
    await f.client.stop();
  });

  it("dispatches only stream.online notifications to the application", async () => {
    const f = createClient();
    f.client.start();
    f.sockets[0]?.message({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "s" } } });
    await vi.waitFor(() => expect(f.onSessionReady).toHaveBeenCalledOnce());
    f.sockets[0]?.message({ metadata: { message_type: "notification", subscription_type: "stream.online" }, payload: { event: onlineEvent } });
    await vi.waitFor(() => expect(f.onStreamOnline).toHaveBeenCalledWith(onlineEvent));
    f.sockets[0]?.message({ metadata: { message_type: "notification", subscription_type: "channel.update" }, payload: { event: onlineEvent } });
    expect(f.onStreamOnline).toHaveBeenCalledOnce();
    await f.client.stop();
  });

  it("ignores keepalive messages", async () => {
    const f = createClient();
    f.client.start();
    f.sockets[0]?.message({ metadata: { message_type: "session_keepalive" }, payload: {} });
    expect(f.onStreamOnline).not.toHaveBeenCalled();
    await f.client.stop();
  });

  it("logs revocations and malformed messages without throwing", async () => {
    const f = createClient();
    f.client.start();
    f.sockets[0]?.message("not json");
    f.sockets[0]?.message({ metadata: { message_type: "revocation" }, payload: { subscription: { status: "authorization_revoked" } } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("malformed"));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("authorization_revoked"));
    await f.client.stop();
  });

  it("uses Twitch reconnect URL, subscribes the replacement and then closes old socket", async () => {
    const sockets: FakeWebSocket[] = [];
    const subscribeToOnline = vi.fn(async () => undefined);
    const client = new EventSubClient({
      broadcasterIds: ["id-1"],
      twitch: { subscribeToOnline, resolveChannels: vi.fn(), getLiveStreams: vi.fn() },
      onStreamOnline: vi.fn(async () => undefined),
      logger,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    client.start();
    const oldSocket = sockets[0];
    oldSocket?.message({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "old-session" } } });
    await vi.waitFor(() => expect(subscribeToOnline).toHaveBeenCalledTimes(1));
    oldSocket?.message({ metadata: { message_type: "session_reconnect" }, payload: { session: { reconnect_url: "wss://next.example/session" } } });
    expect(sockets).toHaveLength(2);
    sockets[1]?.message({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "new-session" } } });
    await vi.waitFor(() => expect(oldSocket?.close).toHaveBeenCalled());
    expect(subscribeToOnline).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it("logs subscription failure but attempts remaining broadcasters", async () => {
    const f = createClient();
    f.subscribeToOnline.mockRejectedValueOnce(new Error("HTTP 401"));
    f.client.start();
    f.sockets[0]?.message({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "session" } } });
    await vi.waitFor(() => expect(f.subscribeToOnline).toHaveBeenCalledTimes(2));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to subscribe"));
    await f.client.stop();
  });
});
