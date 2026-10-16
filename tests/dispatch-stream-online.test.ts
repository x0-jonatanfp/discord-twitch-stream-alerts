import { describe, expect, it, vi } from "vitest";
import { createStreamDispatcher } from "../src/application/dispatch-stream-online.js";

const config = {
  guilds: [
    { guildId: "guild-a", alertChannelId: "alerts-a", twitchChannels: ["channelone", "shared"] },
    { guildId: "guild-b", alertChannelId: "alerts-b", twitchChannels: ["shared"] },
  ],
};
const event = {
  id: "event-1",
  broadcaster_user_id: "broadcaster-1",
  broadcaster_user_login: "Shared",
  broadcaster_user_name: "SharedName",
  title: "Playing a game",
  started_at: "2025-01-02T03:04:05Z",
  category_name: "Game",
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("createStreamDispatcher", () => {
  it("sends one event to every subscribing guild, sharing one streamer across guilds", async () => {
    const notify = vi.fn(async (_input: { guildId: string; channelId: string; stream: { url: string } }) => undefined);
    const dispatch = createStreamDispatcher({ config, notifier: { notify }, logger });

    await dispatch(event);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ guildId: "guild-a", channelId: "alerts-a" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ guildId: "guild-b", channelId: "alerts-b" }));
    expect(notify.mock.calls[0]?.[0].stream.url).toBe("https://www.twitch.tv/Shared");
  });

  it("deduplicates EventSub delivery IDs", async () => {
    const notify = vi.fn(async () => undefined);
    const dispatch = createStreamDispatcher({ config, notifier: { notify }, logger });
    await dispatch(event);
    await dispatch(event);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("ignores channels not subscribed by any configured guild", async () => {
    const notify = vi.fn(async () => undefined);
    const dispatch = createStreamDispatcher({ config, notifier: { notify }, logger });
    await dispatch({ ...event, broadcaster_user_login: "other" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("isolates one guild send failure while notifying the others", async () => {
    const notify = vi.fn(async ({ guildId }: { guildId: string }) => {
      if (guildId === "guild-a") throw new Error("Missing Permissions");
    });
    const error = vi.fn();
    const dispatch = createStreamDispatcher({ config, notifier: { notify }, logger: { ...logger, error } });
    await expect(dispatch(event)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
  });

  it("converts missing category to an empty string", async () => {
    const notify = vi.fn(async (_input: { guildId: string; channelId: string; stream: { categoryName: string } }) => undefined);
    const dispatch = createStreamDispatcher({ config, notifier: { notify }, logger });
    await dispatch({ ...event, category_name: undefined });
    expect(notify.mock.calls[0]?.[0].stream.categoryName).toBe("");
  });
});
