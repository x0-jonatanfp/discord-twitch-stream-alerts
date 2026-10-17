import type {
  LiveStream,
  StreamSubscriber,
} from "../domain/entities/stream.js";
import type {
  LiveStreamState,
  LiveStreamStateEntry,
  LiveStateStorePort,
} from "../domain/ports/live-state-store.js";
import type { LoggerPort } from "../domain/ports/logger.js";
import type { StreamNotifierPort } from "../domain/ports/stream-notifier.js";
import type { TwitchStreamsPort } from "../domain/ports/twitch-streams.js";

export interface ReconciliationDependencies {
  subscribersByBroadcasterId: ReadonlyMap<string, readonly StreamSubscriber[]>;
  twitch: TwitchStreamsPort;
  notifier: StreamNotifierPort;
  stateStore: LiveStateStorePort;
  logger: LoggerPort;
}

export function createLiveStreamReconciler(dependencies: ReconciliationDependencies) {
  const allBroadcasterIds = [...dependencies.subscribersByBroadcasterId.keys()];
  let knownLive: LiveStreamState = {};
  let initialized = false;
  let stateDirty = false;
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
    await ensureInitialized();
    const liveStreams = await dependencies.twitch.getLiveStreams(allBroadcasterIds);
    const currentState: LiveStreamState = {};

    for (const stream of liveStreams) {
      const subscribers = dependencies.subscribersByBroadcasterId.get(stream.broadcasterId);
      if (!subscribers || subscribers.length === 0) continue;

      const previous = knownLive[stream.broadcasterId];
      const entry = previous?.streamId === stream.id
        ? { streamId: stream.id, deliveredTo: expandDeliveredTo(previous, subscribers) }
        : { streamId: stream.id, deliveredTo: [] };

      await deliverPending(stream, entry, subscribers);
      currentState[stream.broadcasterId] = entry;
    }

    const changed = stateDiffers(knownLive, currentState);
    knownLive = currentState;
    await persistState(changed);
  }

  async function handleOnlineEvent(stream: LiveStream): Promise<void> {
    return enqueueStateChange(async () => {
      await ensureInitialized();
      const subscribers = dependencies.subscribersByBroadcasterId.get(stream.broadcasterId);
      if (!subscribers || subscribers.length === 0) {
        dependencies.logger.warn(
          `Skipping Twitch alert for ${stream.broadcasterLogin}: broadcaster is not configured`,
        );
        return;
      }

      const previous = knownLive[stream.broadcasterId];
      const entry = previous?.streamId === stream.id
        ? { streamId: stream.id, deliveredTo: expandDeliveredTo(previous, subscribers) }
        : { streamId: stream.id, deliveredTo: [] };
      let changed = previous?.streamId !== stream.id;
      if (previous?.deliveredTo.includes("*")) changed = true;
      if (await deliverPending(stream, entry, subscribers)) changed = true;

      knownLive = { ...knownLive, [stream.broadcasterId]: entry };
      await persistState(changed);
    });
  }

  async function persistState(force: boolean): Promise<void> {
    if (!force && !stateDirty) return;
    try {
      await dependencies.stateStore.save(knownLive);
      stateDirty = false;
    } catch (error) {
      // Keep the in-memory state so the next cycle can persist it without
      // re-sending alerts that already succeeded.
      stateDirty = true;
      throw error;
    }
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    knownLive = await dependencies.stateStore.load();
    initialized = true;
  }

  async function deliverPending(
    stream: LiveStream,
    entry: LiveStreamStateEntry,
    subscribers: readonly StreamSubscriber[],
  ): Promise<boolean> {
    if (entry.deliveredTo.includes("*")) return false;

    const pending = subscribers.filter(
      (subscriber) => !entry.deliveredTo.includes(subscriberKey(subscriber)),
    );
    if (pending.length === 0) return false;

    const results = await Promise.allSettled(pending.map((subscriber) =>
      dependencies.notifier.notify({
        guildId: subscriber.guildId,
        channelId: subscriber.channelId,
        stream,
      }),
    ));

    let changed = false;
    results.forEach((result, index) => {
      const subscriber = pending[index];
      if (result.status === "fulfilled") {
        if (subscriber) {
          entry.deliveredTo.push(subscriberKey(subscriber));
          changed = true;
        }
        return;
      }
      dependencies.logger.error(
        `failed to notify guild ${subscriber?.guildId ?? "unknown"} for Twitch stream ${stream.broadcasterLogin}: ${errorMessage(result.reason)}`,
      );
    });
    return changed;
  }

  return { reconcile, handleOnlineEvent };
}

function subscriberKey(subscriber: StreamSubscriber): string {
  return `${subscriber.guildId}:${subscriber.channelId}`;
}

function expandDeliveredTo(
  entry: LiveStreamStateEntry,
  subscribers: readonly StreamSubscriber[],
): string[] {
  return entry.deliveredTo.includes("*")
    ? subscribers.map(subscriberKey)
    : [...entry.deliveredTo];
}

function stateDiffers(left: LiveStreamState, right: LiveStreamState): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return true;

  return rightKeys.some((broadcasterId) => {
    const previous = left[broadcasterId];
    const next = right[broadcasterId];
    if (!previous || !next) return true;
    if (previous.streamId !== next.streamId) return true;
    if (previous.deliveredTo.length !== next.deliveredTo.length) return true;
    return previous.deliveredTo.some((value, index) => value !== next.deliveredTo[index]);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
