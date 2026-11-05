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
  now?: () => number;
}

/** Twitch renders a new preview about every five minutes. */
const PREVIEW_REFRESH_MS = 5 * 60 * 1000;

export function createLiveStreamReconciler(dependencies: ReconciliationDependencies) {
  const allBroadcasterIds = [...dependencies.subscribersByBroadcasterId.keys()];
  let knownLive: LiveStreamState = {};
  let initialized = false;
  let stateDirty = false;
  let reconcileInFlight: Promise<void> | null = null;
  let stateQueue: Promise<void> = Promise.resolve();
  // When each live alert's preview was last refreshed. Memory only: after a
  // restart every live alert is refreshed once on the next poll.
  const lastPreviewRefresh = new Map<string, number>();
  const now = dependencies.now ?? Date.now;

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
    await endMissingStreams(liveStreams);
    const currentState: LiveStreamState = {};

    for (const stream of liveStreams) {
      const subscribers = dependencies.subscribersByBroadcasterId.get(stream.broadcasterId);
      if (!subscribers || subscribers.length === 0) continue;

      const previous = knownLive[stream.broadcasterId];
      const entry: LiveStreamStateEntry = previous?.streamId === stream.id
        ? { streamId: stream.id, deliveredTo: expandDeliveredTo(previous, subscribers), alerts: [...previous.alerts] }
        : { streamId: stream.id, deliveredTo: [], alerts: [] };

      await deliverPending(stream, entry, subscribers);
      await refreshPreviews(stream, entry);
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
      if (previous && previous.streamId !== stream.id) {
        await endStream(previous);
      }
      const entry: LiveStreamStateEntry = previous?.streamId === stream.id
        ? { streamId: stream.id, deliveredTo: expandDeliveredTo(previous, subscribers), alerts: [...previous.alerts] }
        : { streamId: stream.id, deliveredTo: [], alerts: [] };
      let changed = previous?.streamId !== stream.id;
      if (previous?.deliveredTo.includes("*")) changed = true;
      if (await deliverPending(stream, entry, subscribers)) changed = true;

      knownLive = { ...knownLive, [stream.broadcasterId]: entry };
      await persistState(changed);
    });
  }

  /**
   * Marks the alerts of streams that disappeared or were replaced as ended.
   * The reconciliation poll is the source of truth, so endings are detected
   * even if the bot missed a stream.offline event or was down.
   */
  async function endMissingStreams(liveStreams: readonly LiveStream[]): Promise<void> {
    const liveById = new Map(liveStreams.map((stream) => [stream.broadcasterId, stream]));
    const ended = Object.entries(knownLive).filter(([broadcasterId, entry]) => {
      const current = liveById.get(broadcasterId);
      return !current || current.id !== entry.streamId;
    });
    await Promise.all(ended.map(([, entry]) => endStream(entry)));
  }

  /**
   * Keeps the live alerts' picture current (Twitch renders a new preview about
   * every five minutes). Ended alerts are never part of this: they leave the
   * state when the stream ends and are not edited again.
   */
  async function refreshPreviews(stream: LiveStream, entry: LiveStreamStateEntry): Promise<void> {
    if (!stream.thumbnailUrl) return;
    for (const alert of entry.alerts) {
      const last = lastPreviewRefresh.get(alert.messageId);
      if (last !== undefined && now() - last < PREVIEW_REFRESH_MS) continue;
      lastPreviewRefresh.set(alert.messageId, now());
      try {
        await dependencies.notifier.refreshPreview({ ...alert, thumbnailUrl: stream.thumbnailUrl });
      } catch (error) {
        dependencies.logger.warn(
          `Could not refresh the preview of Twitch alert ${alert.messageId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  async function endStream(entry: LiveStreamStateEntry): Promise<void> {
    for (const alert of entry.alerts) lastPreviewRefresh.delete(alert.messageId);
    if (entry.alerts.length === 0) return;
    const results = await Promise.allSettled(entry.alerts.map((alert) =>
      dependencies.notifier.markStreamEnded(alert),
    ));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        dependencies.logger.warn(
          `Could not mark Twitch alert ${entry.alerts[index]?.messageId ?? "unknown"} as ended: ${errorMessage(result.reason)}`,
        );
      }
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
          lastPreviewRefresh.set(result.value.messageId, now());
          entry.alerts.push({
            guildId: subscriber.guildId,
            channelId: subscriber.channelId,
            messageId: result.value.messageId,
          });
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
    if (previous.deliveredTo.some((value, index) => value !== next.deliveredTo[index])) return true;
    if (previous.alerts.length !== next.alerts.length) return true;
    return previous.alerts.some((alert, index) => alert.messageId !== next.alerts[index]?.messageId);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
