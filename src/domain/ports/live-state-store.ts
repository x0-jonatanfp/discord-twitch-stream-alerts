import type { StreamAlertMessage } from "../entities/stream.js";

export interface LiveStreamStateEntry {
  streamId: string;
  /**
   * Subscriber keys (`guildId:channelId`) that already received this stream's
   * alert. `"*"` means every subscriber (legacy state format).
   */
  deliveredTo: string[];
  /** Alerts posted for this stream, used to dim their embed when it ends. */
  alerts: StreamAlertMessage[];
}

export type LiveStreamState = Record<string, LiveStreamStateEntry>;

export interface LiveStateStorePort {
  load(): Promise<LiveStreamState>;
  save(state: LiveStreamState): Promise<void>;
}
