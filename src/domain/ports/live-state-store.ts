export interface LiveStreamStateEntry {
  streamId: string;
  /**
   * Subscriber keys (`guildId:channelId`) that already received this stream's
   * alert. `"*"` means every subscriber (legacy state format).
   */
  deliveredTo: string[];
}

export type LiveStreamState = Record<string, LiveStreamStateEntry>;

export interface LiveStateStorePort {
  load(): Promise<LiveStreamState>;
  save(state: LiveStreamState): Promise<void>;
}
