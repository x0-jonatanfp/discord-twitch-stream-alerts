export interface GuildStreamSettings {
  guildId: string;
  alertChannelId: string;
  twitchChannels: string[];
}

export interface StreamSubscriptionConfig {
  guilds: GuildStreamSettings[];
}

export interface TwitchChannel {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  url: string;
}

export interface StreamSubscriber {
  guildId: string;
  channelId: string;
}

export interface LiveStream {
  id: string;
  broadcasterId: string;
  broadcasterLogin: string;
  broadcasterName: string;
  title: string;
  categoryName: string;
  startedAt: string;
  url: string;
  thumbnailUrl: string;
  viewerCount: number;
  profileImageUrl: string;
  isLive: true;
}

/**
 * Payload of Twitch's `stream.online` event. It intentionally does not include
 * title/category: Twitch does not send them, so they must be fetched from Helix.
 */
export interface StreamOnlineEvent {
  id: string;
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  type?: string;
  started_at: string;
}
