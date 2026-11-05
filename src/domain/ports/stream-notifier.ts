import type { LiveStream, StreamAlertMessage } from "../entities/stream.js";

export interface StreamNotifierPort {
  notify(input: { guildId: string; channelId: string; stream: LiveStream }): Promise<{ messageId: string }>;
  markStreamEnded(input: StreamAlertMessage): Promise<void>;
  /**
   * Freezes the live preview into the alert so it keeps its own picture after
   * the broadcast ends. Resolves true when the alert has its preview attached
   * (now or already) and false when it should be retried later.
   */
  attachPreview(input: StreamAlertMessage & { thumbnailUrl: string }): Promise<boolean>;
}
