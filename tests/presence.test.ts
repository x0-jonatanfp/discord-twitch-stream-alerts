import { ActivityType, Events, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { parseAppConfig } from "../src/infrastructure/config/env.js";
import { attachPersistentPresence, buildBotActivity } from "../src/infrastructure/discord/presence.js";

const base = {
  DISCORD_TOKEN: "discord-test-token",
  TWITCH_CLIENT_ID: "twitch-client-id",
  TWITCH_CLIENT_SECRET: "twitch-client-secret",
  TWITCH_USER_ACCESS_TOKEN: "user-access-token",
  TWITCH_REFRESH_TOKEN: "refresh-token",
};

function logger() {
  return { warn: vi.fn() };
}

function fakeClient(ready = true) {
  const handlers = new Map<string, () => void>();
  const setPresence = vi.fn();
  const client = {
    isReady: () => ready,
    user: { setPresence },
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return client;
    },
  } as unknown as Client;
  return { client, handlers, setPresence };
}

describe("persistent Discord presence", () => {
  it("builds the same custom domain-link activity used by server-status", () => {
    const config = parseAppConfig({
      ...base,
      BOT_ACTIVITY_TYPE: "Custom",
      BOT_ACTIVITY_NAME: "x0void.com",
      BOT_ACTIVITY_STATE: "🔗 x0void.com",
      BOT_ACTIVITY_URL: "x0void.com",
    });

    expect(buildBotActivity(config)).toEqual({
      name: "x0void.com",
      type: ActivityType.Custom,
      state: "🔗 x0void.com",
    });
  });

  it("reapplies activity on shard ready, resume and explicit refresh", () => {
    const config = parseAppConfig({ ...base, BOT_ACTIVITY_NAME: "x0void.com", BOT_ACTIVITY_STATE: "🔗 x0void.com" });
    const { client, handlers, setPresence } = fakeClient();
    const refresh = attachPersistentPresence(client, config, logger());

    expect(handlers.has(Events.ShardReady)).toBe(true);
    expect(handlers.has(Events.ShardResume)).toBe(true);
    handlers.get(Events.ShardReady)?.();
    handlers.get(Events.ShardResume)?.();
    refresh();

    const expected = {
      status: "online",
      activities: [{ name: "x0void.com", type: ActivityType.Custom, state: "🔗 x0void.com" }],
    };
    expect(setPresence).toHaveBeenCalledTimes(3);
    expect(setPresence).toHaveBeenLastCalledWith(expected);
  });

  it("does not send presence until Discord is ready", () => {
    const config = parseAppConfig(base);
    const { client, setPresence } = fakeClient(false);
    attachPersistentPresence(client, config, logger())();

    expect(setPresence).not.toHaveBeenCalled();
  });

  it("logs a synchronous Discord presence error without interrupting the caller", () => {
    const config = parseAppConfig(base);
    const { client, setPresence } = fakeClient();
    setPresence.mockImplementation(() => { throw new Error("gateway unavailable"); });
    const log = logger();
    const refresh = attachPersistentPresence(client, config, log);

    expect(() => refresh()).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("gateway unavailable"));
  });
});
