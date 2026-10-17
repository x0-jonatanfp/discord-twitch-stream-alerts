import type { LiveStream, TwitchChannel } from "../entities/stream.js";

export interface TwitchStreamsPort {
  resolveChannels(logins: string[]): Promise<TwitchChannel[]>;
  subscribeToOnline(broadcasterId: string, sessionId: string): Promise<void>;
  getLiveStreams(broadcasterIds: string[]): Promise<LiveStream[]>;
}
