import type { LiveStream, StreamSubscriptionConfig } from "../domain/entities/stream.js";
import type { LiveStateStorePort } from "../domain/ports/live-state-store.js";
import type { LoggerPort } from "../domain/ports/logger.js";
import type { StreamNotifierPort } from "../domain/ports/stream-notifier.js";
import type { TwitchStreamsPort } from "../domain/ports/twitch-streams.js";

export interface ReconciliationDependencies {
  config: StreamSubscriptionConfig;
  twitch: TwitchStreamsPort;
  notifier: StreamNotifierPort;
  stateStore: LiveStateStorePort;
  logger: LoggerPort;
}

export function createLiveStreamReconciler(dependencies: ReconciliationDependencies) {
  const loginToGuilds = new Map<string, Array<{ guildId: string; channelId: string }>>();
  for (const guild of dependencies.config.guilds) {
    for (const login of guild.twitchChannels) {
      const normalizedLogin = login.toLowerCase();
      const subscribers = loginToGuilds.get(normalizedLogin) ?? [];
      subscribers.push({ guildId: guild.guildId, channelId: guild.alertChannelId });
      loginToGuilds.set(normalizedLogin, subscribers);
    }
  }

  let knownLive: Record<string, string> = {};
  let initialized = false;
  let reconcileInFlight: Promise<void> | null = null;
  let stateQueue: Promise<void> = Promise.resolve();

  function enqueueStateChange(task: () => Promise<void>): Promise<void> {
    const operation = stateQueue.then(task);
    stateQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function reconcile(): Promise<void> {
    if (reconcileInFlight) return reconcileInFlight;
    reconcileInFlight = enqueueStateChange(performReconcile);
    try {
      await reconcileInFlight;
    } finally {
      reconcileInFlight = null;
    }
  }

  async function performReconcile(): Promise<void> {
    if (!initialized) {
      knownLive = await dependencies.stateStore.load();
      initialized = true;
    }
    const logins = [...loginToGuilds.keys()];
    const channels = await dependencies.twitch.resolveChannels(logins);
    const loginById = new Map(channels.map((channel) => [channel.id, channel.login.toLowerCase()]));
    const liveStreams = await dependencies.twitch.getLiveStreams(channels.map((channel) => channel.id));
    const currentState: Record<string, string> = {};

    for (const stream of liveStreams) {
      currentState[stream.broadcasterId] = stream.id;
      const previousStreamId = knownLive[stream.broadcasterId];
      if (previousStreamId === stream.id) continue;
      await notifySubscribers(stream, loginById);
    }

    // Keep saved state only for IDs we no longer monitor; resolved offline channels are removed.
    knownLive = currentState;
    await dependencies.stateStore.save(knownLive);
    initialized = true;
  }

  async function handleOnlineEvent(stream: LiveStream): Promise<void> {
    return enqueueStateChange(async () => {
      if (!initialized) {
        knownLive = await dependencies.stateStore.load();
        initialized = true;
      }
      if (knownLive[stream.broadcasterId] === stream.id) return;
      await notifySubscribers(stream, new Map([[stream.broadcasterId, stream.broadcasterLogin.toLowerCase()]]));
      knownLive[stream.broadcasterId] = stream.id;
      await dependencies.stateStore.save(knownLive);
    });
  }

  async function notifySubscribers(stream: LiveStream, loginById: Map<string, string>): Promise<void> {
    const login = loginById.get(stream.broadcasterId) ?? stream.broadcasterLogin.toLowerCase();
    const subscribers = loginToGuilds.get(login) ?? [];
    const results = await Promise.allSettled(subscribers.map(({ guildId, channelId }) =>
      dependencies.notifier.notify({ guildId, channelId, stream }),
    ));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        dependencies.logger.error(
          `failed to notify guild ${subscribers[index]?.guildId ?? "unknown"} for ${stream.broadcasterLogin}: ${errorMessage(result.reason)}`,
        );
      }
    });
  }

  return { reconcile, handleOnlineEvent };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
