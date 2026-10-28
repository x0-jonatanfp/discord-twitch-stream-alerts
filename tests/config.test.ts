import { describe, expect, it } from "vitest";
import { ConfigError, parseAppConfig } from "../src/infrastructure/config/env.js";

const base = {
  DISCORD_TOKEN: "discord-test-token",
  TWITCH_CLIENT_ID: "twitch-client-id",
  TWITCH_CLIENT_SECRET: "twitch-client-secret",
  TWITCH_USER_ACCESS_TOKEN: "user-access-token",
  TWITCH_REFRESH_TOKEN: "refresh-token",
};

describe("parseAppConfig", () => {
  it("loads required config and defaults", () => {
    expect(parseAppConfig(base)).toMatchObject({
      twitchRedirectUri: "http://localhost:3000",
      botActivityType: "Custom",
      botActivityName: "server status",
      botActivityState: null,
      botActivityUrl: null,
      reconcileIntervalSeconds: 60,
      showViewerCount: false,
      guildConfigPath: expect.stringContaining("config/guilds.json"),
      liveStatePath: expect.stringContaining("data/live-state.json"),
    });
  });

  it.each(["true", "TRUE", "TrUe"])("enables viewer count for SHOW_VIEWER_COUNT=%s", (value) => {
    expect(parseAppConfig({ ...base, SHOW_VIEWER_COUNT: value }).showViewerCount).toBe(true);
  });

  it.each(["false", "FALSE", "FaLsE"])("disables viewer count for SHOW_VIEWER_COUNT=%s", (value) => {
    expect(parseAppConfig({ ...base, SHOW_VIEWER_COUNT: value }).showViewerCount).toBe(false);
  });

  it.each(["yes", "1", ""])("rejects invalid SHOW_VIEWER_COUNT value %j", (value) => {
    expect(() => parseAppConfig({ ...base, SHOW_VIEWER_COUNT: value })).toThrow(ConfigError);
    expect(() => parseAppConfig({ ...base, SHOW_VIEWER_COUNT: value })).toThrow(/SHOW_VIEWER_COUNT/);
  });

  it.each(["DISCORD_TOKEN", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_USER_ACCESS_TOKEN", "TWITCH_REFRESH_TOKEN"])(
    "requires %s for bot runtime",
    (key) => {
      const env = { ...base, [key]: "" };
      expect(() => parseAppConfig(env)).toThrow(new RegExp(key));
    },
  );

  it("allows OAuth helper to run before Discord and user tokens exist", () => {
    const config = parseAppConfig({
      TWITCH_CLIENT_ID: base.TWITCH_CLIENT_ID,
      TWITCH_CLIENT_SECRET: base.TWITCH_CLIENT_SECRET,
    }, ".env", { requireDiscordToken: false, requireUserTokens: false, validateActivityUrl: false });
    expect(config.discordToken).toBe("");
    expect(config.twitchUserAccessToken).toBe("");      expect(config.twitchRefreshToken).toBe("");
  });

  it("accepts the server-status custom activity format with a plain domain state", () => {
    expect(parseAppConfig({
      ...base,
      BOT_ACTIVITY_TYPE: "Custom",
      BOT_ACTIVITY_NAME: "x0void.com",
      BOT_ACTIVITY_STATE: "🔗 x0void.com",
      BOT_ACTIVITY_URL: "x0void.com",
    })).toMatchObject({
      botActivityType: "Custom",
      botActivityName: "x0void.com",
      botActivityState: "🔗 x0void.com",
      botActivityUrl: "x0void.com",
    });
  });

  it.each(["Playing", "Streaming", "Listening", "Watching", "Custom", "Competing"])(
    "accepts bot activity type %s",
    (type) => expect(parseAppConfig({ ...base, BOT_ACTIVITY_TYPE: type }).botActivityType).toBe(type),
  );

  it("rejects an unknown bot activity type", () => {
    expect(() => parseAppConfig({ ...base, BOT_ACTIVITY_TYPE: "Invisible" })).toThrow(/BOT_ACTIVITY_TYPE/);
  });

  it.each(["https://example.com/stream", "http://www.twitch.tv/channel", "https://evil-twitch.tv/channel", "not-a-url"])(
    "rejects invalid streaming activity URL %s",
    (url) => expect(() => parseAppConfig({ ...base, BOT_ACTIVITY_TYPE: "Streaming", BOT_ACTIVITY_URL: url })).toThrow(ConfigError),
  );

  it.each(["https://www.twitch.tv/channel", "https://youtu.be/abc", "https://www.youtube.com/watch?v=abc"])(
    "accepts supported streaming activity URL %s",
    (url) => expect(parseAppConfig({ ...base, BOT_ACTIVITY_TYPE: "Streaming", BOT_ACTIVITY_URL: url }).botActivityUrl).toBe(url),
  );

  it("requires local HTTP redirect URL with explicit non-privileged port", () => {
    expect(() => parseAppConfig({ ...base, TWITCH_REDIRECT_URI: "http://localhost" })).toThrow(/explicit local port/);
    expect(() => parseAppConfig({ ...base, TWITCH_REDIRECT_URI: "http://localhost:80/callback" })).toThrow(/explicit local port/);
    expect(() => parseAppConfig({ ...base, TWITCH_REDIRECT_URI: "https://example.com/callback" })).toThrow(/localhost/);
    expect(() => parseAppConfig({ ...base, TWITCH_REDIRECT_URI: "http://192.168.1.2:3000" })).toThrow(/localhost/);
  });

  it.each(["14", "3601", "1.5", "abc"])("rejects invalid reconciliation interval %s", (interval) => {
    expect(() => parseAppConfig({ ...base, TWITCH_RECONCILE_INTERVAL_SECONDS: interval })).toThrow(/TWITCH_RECONCILE_INTERVAL_SECONDS/);
  });

  it("logs only to console unless LOG_FILE is set", () => {
    expect(parseAppConfig(base).logFile).toBeNull();
    expect(parseAppConfig({ ...base, LOG_FILE: "  " }).logFile).toBeNull();
  });

  it("resolves LOG_FILE to an absolute path", () => {
    expect(parseAppConfig({ ...base, LOG_FILE: "/var/log/announcements.log" }).logFile).toBe("/var/log/announcements.log");
    expect(parseAppConfig({ ...base, LOG_FILE: "logs/bot.log" }).logFile).toMatch(/^\/.*\/logs\/bot\.log$/);
  });

  it("accepts configured interval bounds", () => {
    expect(parseAppConfig({ ...base, TWITCH_RECONCILE_INTERVAL_SECONDS: "15" }).reconcileIntervalSeconds).toBe(15);
    expect(parseAppConfig({ ...base, TWITCH_RECONCILE_INTERVAL_SECONDS: "3600" }).reconcileIntervalSeconds).toBe(3600);
  });
});
