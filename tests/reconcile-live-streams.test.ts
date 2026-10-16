import { describe, expect, it, vi } from "vitest";
import { createLiveStreamReconciler } from "../src/application/reconcile-live-streams.js";
import type { LiveStream } from "../src/domain/entities/stream.js";

const config = {
  guilds: [
    { guildId: "guild-a", alertChannelId: "alerts-a", twitchChannels: ["one", "shared"] },
    { guildId: "guild-b", alertChannelId: "alerts-b", twitchChannels: ["shared"] },
  ],
};
const stream: LiveStream = {
  id: "stream-1", broadcasterId: "id-1", broadcasterLogin: "shared", broadcasterName: "Shared",
  title: "Title", categoryName: "Game", startedAt: "2025-01-02T03:04:05Z", url: "https://www.twitch.tv/shared",
  thumbnailUrl: "https://images.example/frame.jpg", viewerCount: 10, profileImageUrl: "https://images.example/avatar.png", isLive: true,
};
const channelList = [
  { id: "id-1", login: "shared", displayName: "Shared", profileImageUrl: "https://images.example/shared.png", url: "https://www.twitch.tv/shared" },
  { id: "id-2", login: "one", displayName: "One", profileImageUrl: "https://images.example/one.png", url: "https://www.twitch.tv/one" },
];

function fixture(options: { saved?: Record<string, string>; live?: LiveStream[] } = {}) {
  const notify = vi.fn(async () => undefined);
  const saved = { ...(options.saved ?? {}) };
  const stateStore = {
    load: vi.fn(async () => ({ ...saved })),
    save: vi.fn(async (state: Record<string, string>) => {
      for (const key of Object.keys(saved)) delete saved[key];
      Object.assign(saved, state);
    }),
  };
  const twitch = {
    resolveChannels: vi.fn(async () => channelList),
    getChannelProfile: vi.fn(async (id: string) => ({
      id, login: "shared", displayName: "Shared", profileImageUrl: "https://images.example/shared.png",
      url: "https://www.twitch.tv/shared", isLive: false as const,
    })),
    getLiveStreams: vi.fn(async () => options.live ?? [stream]),
    subscribeToOnline: vi.fn(async () => undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reconciler = createLiveStreamReconciler({ config, twitch, notifier: { notify }, stateStore, logger });
  return { notify, stateStore, twitch, logger, reconciler, saved };
}

describe("createLiveStreamReconciler", () => {
  it("announces a live stream on first run when no previous state exists", async () => {
    const f = fixture();
    await f.reconciler.reconcile();
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.saved["id-1"]).toBe("stream-1");
  });

  it("does not announce an unchanged stream during subsequent polling", async () => {
    const f = fixture();
    await f.reconciler.reconcile();
    f.notify.mockClear();
    await f.reconciler.reconcile();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("does not announce a stream already live according to saved state on restart", async () => {
    const f = fixture({ saved: { "id-1": "stream-1" } });
    await f.reconciler.reconcile();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("announces new stream ID from same broadcaster", async () => {
    const f = fixture({ saved: { "id-1": "old-stream" } });
    await f.reconciler.reconcile();
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it("removes broadcasters that are now offline from persisted state", async () => {
    const f = fixture({ saved: { "id-1": "stream-1", "stale": "old" }, live: [] });
    await f.reconciler.reconcile();
    expect(f.saved).toEqual({});
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("does not duplicate concurrent reconciliation calls", async () => {
    const f = fixture();
    await Promise.all([f.reconciler.reconcile(), f.reconciler.reconcile()]);
    expect(f.twitch.resolveChannels).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it("uses an EventSub event immediately and suppresses the later same REST stream", async () => {
    const f = fixture({ saved: {}, live: [] });
    await f.reconciler.reconcile();
    await f.reconciler.handleOnlineEvent(stream);
    expect(f.notify).toHaveBeenCalledTimes(2);
    await f.reconciler.handleOnlineEvent(stream);
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it("loads persisted state before handling an EventSub event so duplicate restarts are suppressed", async () => {
    const f = fixture({ saved: { "id-1": "stream-1" }, live: [] });
    await f.reconciler.handleOnlineEvent(stream);
    expect(f.stateStore.load).toHaveBeenCalledOnce();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("loads persisted state once", async () => {
    const f = fixture();
    await f.reconciler.reconcile();
    await f.reconciler.reconcile();
    expect(f.stateStore.load).toHaveBeenCalledOnce();
  });

  it("preserves the previous in-memory state if Twitch lookup fails", async () => {
    const f = fixture({ saved: { "id-1": "stream-1" } });
    await f.reconciler.reconcile();
    f.twitch.getLiveStreams.mockRejectedValueOnce(new Error("network"));
    await expect(f.reconciler.reconcile()).rejects.toThrow("network");
    f.twitch.getLiveStreams.mockResolvedValueOnce([stream]);
    await f.reconciler.reconcile();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("uses Twitch resolved logins to route notifications", async () => {
    const f = fixture({ live: [{ ...stream, broadcasterLogin: "SHARED" }] });
    await f.reconciler.reconcile();
    expect(f.notify).toHaveBeenCalledTimes(2);
  });
});
