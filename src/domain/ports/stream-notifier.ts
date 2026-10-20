import type { LiveStream, StreamAlertMessage } from "../entities/stream.js";

export interface StreamNotifierPort {
  notify(input: { guildId: string; channelId: string; stream: LiveStream }): Promise<{ messageId: string }>;
  markStreamEnded(input: StreamAlertMessage): Promise<void>;
}
