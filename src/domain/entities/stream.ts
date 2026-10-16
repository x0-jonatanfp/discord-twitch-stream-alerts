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


export interface ChannelProfile {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  url: string;
  isLive: false;
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

export type StreamAlert = ChannelProfile | LiveStream;

export interface StreamOnlineEvent {
  id: string;
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  title: string;
  started_at: string;
  category_name?: string;
}
