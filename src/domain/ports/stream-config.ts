import type { StreamSubscriptionConfig } from "../entities/stream.js";

export interface StreamConfigPort {
  load(): Promise<StreamSubscriptionConfig>;
}
