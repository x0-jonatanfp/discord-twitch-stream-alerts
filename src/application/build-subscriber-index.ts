import type {
  GuildStreamSettings,
  StreamSubscriber,
  TwitchChannel,
} from "../domain/entities/stream.js";

export interface SubscriberIndex {
  broadcasterIds: string[];
  subscribersByBroadcasterId: Map<string, StreamSubscriber[]>;
  unknownLogins: string[];
}

/**
 * Maps configured Twitch logins to broadcaster IDs once, at startup. From then
 * on, routing is done by broadcaster ID so a streamer renaming their login does
 * not silently break alerts.
 */
export function buildSubscriberIndex(
  guilds: readonly GuildStreamSettings[],
  channels: readonly TwitchChannel[],
): SubscriberIndex {
  const channelByLogin = new Map(
    channels.map((channel) => [channel.login.toLowerCase(), channel]),
  );
  const configuredLogins = new Set(
    guilds.flatMap((guild) => guild.twitchChannels.map((login) => login.toLowerCase())),
  );
  const unknownLogins = [...configuredLogins].filter((login) => !channelByLogin.has(login));

  const subscribersByBroadcasterId = new Map<string, StreamSubscriber[]>();
  for (const guild of guilds) {
    for (const login of guild.twitchChannels) {
      const channel = channelByLogin.get(login.toLowerCase());
      if (!channel) continue;

      const subscribers = subscribersByBroadcasterId.get(channel.id) ?? [];
      const alreadySubscribed = subscribers.some(
        (subscriber) =>
          subscriber.guildId === guild.guildId &&
          subscriber.channelId === guild.alertChannelId,
      );
      if (!alreadySubscribed) {
        subscribers.push({ guildId: guild.guildId, channelId: guild.alertChannelId });
      }
      subscribersByBroadcasterId.set(channel.id, subscribers);
    }
  }

  return {
    broadcasterIds: [...subscribersByBroadcasterId.keys()],
    subscribersByBroadcasterId,
    unknownLogins,
  };
}
