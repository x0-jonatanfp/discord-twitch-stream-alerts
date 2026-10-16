export type LiveStreamState = Record<string, string>;

export interface LiveStateStorePort {
  load(): Promise<LiveStreamState>;
  save(state: LiveStreamState): Promise<void>;
}
