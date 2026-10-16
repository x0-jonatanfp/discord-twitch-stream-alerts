import type { ChannelProfile, LiveStream, TwitchChannel } from "../entities/stream.js";

export interface TwitchStreamsPort {
  resolveChannels(logins: string[]): Promise<TwitchChannel[]>;
  getChannelProfile?(broadcasterId: string): Promise<ChannelProfile>;
  subscribeToOnline(broadcasterId: string, sessionId: string): Promise<void>;
  getLiveStreams(broadcasterIds: string[]): Promise<LiveStream[]>;
}
