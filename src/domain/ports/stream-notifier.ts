import type { LiveStream, StreamAlertMessage } from "../entities/stream.js";

export interface StreamNotifierPort {
  notify(input: { guildId: string; channelId: string; stream: LiveStream }): Promise<{ messageId: string }>;
  markStreamEnded(input: StreamAlertMessage): Promise<void>;
  /**
   * Replaces the preview of a live alert with the latest real one from Twitch.
   * A no-op while Twitch only has its placeholder. Only for live alerts: once an
   * alert is ended it is never edited again.
   */
  refreshPreview(input: StreamAlertMessage & { thumbnailUrl: string }): Promise<void>;
}
