import type { LiveStream } from "../entities/stream.js";

export interface StreamNotifierPort {
  notify(input: { guildId: string; channelId: string; stream: LiveStream }): Promise<void>;
}
