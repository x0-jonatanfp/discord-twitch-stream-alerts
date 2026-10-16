import type { StreamOnlineEvent, StreamSubscriptionConfig } from "../domain/entities/stream.js";
import type { LoggerPort } from "../domain/ports/logger.js";
import type { StreamNotifierPort } from "../domain/ports/stream-notifier.js";

export interface StreamDispatchDependencies {
  config: StreamSubscriptionConfig;
  notifier: StreamNotifierPort;
  logger: LoggerPort;
  seenEventIds?: Set<string>;
}

export function createStreamDispatcher(dependencies: StreamDispatchDependencies) {
  const seenEventIds = dependencies.seenEventIds ?? new Set<string>();
  const loginToGuilds = new Map<string, Array<{ guildId: string; channelId: string }>>();

  for (const guild of dependencies.config.guilds) {
    for (const login of guild.twitchChannels) {
      const normalizedLogin = login.toLowerCase();
      const subscribers = loginToGuilds.get(normalizedLogin) ?? [];
      subscribers.push({ guildId: guild.guildId, channelId: guild.alertChannelId });
      loginToGuilds.set(normalizedLogin, subscribers);
    }
  }

  return async (event: StreamOnlineEvent): Promise<void> => {
    if (seenEventIds.has(event.id)) return;
    seenEventIds.add(event.id);

    const subscribers = loginToGuilds.get(event.broadcaster_user_login.toLowerCase());
    if (!subscribers || subscribers.length === 0) return;

    const stream = {
      id: event.id,
      broadcasterId: event.broadcaster_user_id,
      broadcasterLogin: event.broadcaster_user_login,
      broadcasterName: event.broadcaster_user_name,
      title: event.title,
      categoryName: event.category_name ?? "",
      startedAt: event.started_at,
      url: `https://www.twitch.tv/${encodeURIComponent(event.broadcaster_user_login)}`,
      thumbnailUrl: "",
      viewerCount: 0,
      profileImageUrl: "",
      isLive: true as const,
    };

    const results = await Promise.allSettled(
      subscribers.map(({ guildId, channelId }) =>
        dependencies.notifier.notify({ guildId, channelId, stream }),
      ),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const subscriber = subscribers[index];
        dependencies.logger.error(
          `failed to notify guild ${subscriber?.guildId ?? "unknown"} for Twitch stream ${event.broadcaster_user_login}: ${errorMessage(result.reason)}`,
        );
      }
    });

    // Bound memory for long-running bots while preventing immediate replay duplicates.
    if (seenEventIds.size > 10_000) {
      const oldestIds = [...seenEventIds].slice(0, 5_000);
      for (const id of oldestIds) seenEventIds.delete(id);
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
