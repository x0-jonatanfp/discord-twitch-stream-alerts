import { describe, expect, it, vi } from "vitest";
import { buildSubscriberIndex } from "../src/application/build-subscriber-index.js";
import { createLiveStreamReconciler } from "../src/application/reconcile-live-streams.js";
import type { LiveStream, TwitchChannel } from "../src/domain/entities/stream.js";
import type { LiveStreamState } from "../src/domain/ports/live-state-store.js";

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
const channelList: TwitchChannel[] = [
  { id: "id-1", login: "shared", displayName: "Shared", profileImageUrl: "https://images.example/shared.png", url: "https://www.twitch.tv/shared" },
  { id: "id-2", login: "one", displayName: "One", profileImageUrl: "https://images.example/one.png", url: "https://www.twitch.tv/one" },
];
const index = buildSubscriberIndex(config.guilds, channelList);

function fixture(options: { saved?: LiveStreamState; live?: LiveStream[] } = {}) {
  const notify = vi.fn(async () => undefined);
  let saved: LiveStreamState = structuredClone(options.saved ?? {});
  const stateStore = {
    load: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async (state: LiveStreamState) => {
      saved = structuredClone(state);
    }),
  };
  const twitch = {
    resolveChannels: vi.fn(async () => channelList),
    getLiveStreams: vi.fn(async () => options.live ?? [stream]),
    subscribeToOnline: vi.fn(async () => undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reconciler = createLiveStreamReconciler({
    subscribersByBroadcasterId: index.subscribersByBroadcasterId,
    twitch,
    notifier: { notify },
    stateStore,
    logger,
  });
  return { notify, stateStore, twitch, logger, reconciler, get saved() { return saved; } };
}

describe("createLiveStreamReconciler", () => {
  it("announces a live stream on first run and records every subscriber", async () => {
    const f = fixture();
    await f.reconciler.reconcile();
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.saved["id-1"]).toEqual({
      streamId: "stream-1",
      deliveredTo: ["guild-a:alerts-a", "guild-b:alerts-b"],
    });
  });

  it("does not announce an unchanged stream during subsequent polling", async () => {
    const f = fixture();
    await f.reconciler.reconcile();
    f.notify.mockClear();
    f.stateStore.save.mockClear();
    await f.reconciler.reconcile();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.stateStore.save).not.toHaveBeenCalled();
  });

  it("does not announce a stream already live according to saved state on restart", async () => {
    const f = fixture({ saved: { "id-1": { streamId: "stream-1", deliveredTo: ["*"] } } });
    await f.reconciler.reconcile();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.saved["id-1"]).toEqual({
      streamId: "stream-1",
      deliveredTo: ["guild-a:alerts-a", "guild-b:alerts-b"],
    });
  });

  it("announces a new stream ID from the same broadcaster", async () => {
    const f = fixture({ saved: { "id-1": { streamId: "old-stream", deliveredTo: ["*"] } } });
    await f.reconciler.reconcile();
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.saved["id-1"]?.deliveredTo).not.toContain("*");
  });

  it("removes broadcasters that are now offline from persisted state", async () => {
    const f = fixture({
      saved: {
        "id-1": { streamId: "stream-1", deliveredTo: ["*"] },
        stale: { streamId: "old", deliveredTo: ["*"] },
      },
      live: [],
    });
    await f.reconciler.reconcile();
    expect(f.saved).toEqual({});
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("does not duplicate concurrent reconciliation calls", async () => {
    const f = fixture();
    await Promise.all([f.reconciler.reconcile(), f.reconciler.reconcile()]);
    expect(f.twitch.getLiveStreams).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it("uses an EventSub event immediately and suppresses the later same REST stream", async () => {
    const f = fixture({ live: [] });
    await f.reconciler.reconcile();
    await f.reconciler.handleOnlineEvent(stream);
    expect(f.notify).toHaveBeenCalledTimes(2);
    await f.reconciler.handleOnlineEvent(stream);
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it("loads persisted state before handling an EventSub event so duplicate restarts are suppressed", async () => {
    const f = fixture({ saved: { "id-1": { streamId: "stream-1", deliveredTo: ["*"] } }, live: [] });
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
    const f = fixture({ saved: { "id-1": { streamId: "stream-1", deliveredTo: ["*"] } } });
    await f.reconciler.reconcile();
    f.twitch.getLiveStreams.mockRejectedValueOnce(new Error("network"));
    await expect(f.reconciler.reconcile()).rejects.toThrow("network");
    f.twitch.getLiveStreams.mockResolvedValueOnce([stream]);
    await f.reconciler.reconcile();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("routes by broadcaster ID even when the current login differs from the config", async () => {
    const f = fixture({ live: [{ ...stream, broadcasterLogin: "renamed_login" }] });
    await f.reconciler.reconcile();
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it("retries only the subscribers that failed without duplicating successful ones", async () => {
    const f = fixture();
    f.notify.mockRejectedValueOnce(new Error("Discord 503"));
    await f.reconciler.reconcile();

    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.saved["id-1"]?.deliveredTo).toEqual(["guild-b:alerts-b"]);

    f.notify.mockClear();
    await f.reconciler.reconcile();

    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({ guildId: "guild-a", channelId: "alerts-a" }));
    expect(f.saved["id-1"]?.deliveredTo).toEqual(["guild-b:alerts-b", "guild-a:alerts-a"]);
  });

  it("retries a failed state save without re-notifying", async () => {
    const f = fixture();
    f.stateStore.save.mockRejectedValueOnce(new Error("disk full"));

    await expect(f.reconciler.reconcile()).rejects.toThrow("disk full");
    expect(f.notify).toHaveBeenCalledTimes(2);

    f.notify.mockClear();
    await f.reconciler.reconcile();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.stateStore.save).toHaveBeenCalledTimes(2);
    expect(f.saved["id-1"]?.deliveredTo).toEqual(["guild-a:alerts-a", "guild-b:alerts-b"]);
  });

  it("does not save when only a failed subscriber is retried and fails again", async () => {
    const f = fixture();
    f.notify.mockRejectedValueOnce(new Error("Discord 503"));
    await f.reconciler.reconcile();
    f.stateStore.save.mockClear();

    f.notify.mockRejectedValueOnce(new Error("Discord still down"));
    await f.reconciler.reconcile();

    expect(f.stateStore.save).not.toHaveBeenCalled();
    expect(f.saved["id-1"]?.deliveredTo).toEqual(["guild-b:alerts-b"]);
  });

  it("logs and ignores EventSub events for unconfigured broadcasters", async () => {
    const f = fixture({ live: [] });
    await f.reconciler.handleOnlineEvent({ ...stream, broadcasterId: "unknown" });
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining("not configured"));
  });
});
