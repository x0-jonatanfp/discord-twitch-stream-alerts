import { describe, expect, it } from "vitest";
import { parseGuildConfig, GuildConfigError } from "../src/infrastructure/config/guild-config.js";

const valid = {
  guilds: [
    { guildId: "12345678901234567", alertChannelId: "23456789012345678", twitchChannels: ["Streamer_One", "streamer_two"] },
    { guildId: "34567890123456789", alertChannelId: "45678901234567890", twitchChannels: ["streamer_two"] },
  ],
};

describe("parseGuildConfig", () => {
  it("validates entries and normalizes Twitch login casing", () => {
    expect(parseGuildConfig(valid)).toEqual({
      guilds: [
        { guildId: "12345678901234567", alertChannelId: "23456789012345678", twitchChannels: ["streamer_one", "streamer_two"] },
        { guildId: "34567890123456789", alertChannelId: "45678901234567890", twitchChannels: ["streamer_two"] },
      ],
    });
  });

  it("allows a Twitch login to be monitored by multiple guilds", () => {
    const config = parseGuildConfig(valid);
    expect(config.guilds[0]?.twitchChannels).toContain("streamer_two");
    expect(config.guilds[1]?.twitchChannels).toContain("streamer_two");
  });

  it.each([null, [], "text", {}])("rejects a non-config root: %s", (input) => {
    expect(() => parseGuildConfig(input)).toThrow(GuildConfigError);
  });

  it("rejects malformed Discord IDs", () => {
    expect(() => parseGuildConfig({ guilds: [{ ...valid.guilds[0], guildId: "123" }] })).toThrow(/guildId/);
    expect(() => parseGuildConfig({ guilds: [{ ...valid.guilds[0], alertChannelId: "abc" }] })).toThrow(/alertChannelId/);
  });

  it("rejects duplicate guild IDs", () => {
    expect(() => parseGuildConfig({ guilds: [valid.guilds[0], valid.guilds[0]] })).toThrow(/Duplicate guildId/);
  });

  it("requires at least one valid Twitch login", () => {
    expect(() => parseGuildConfig({ guilds: [{ ...valid.guilds[0], twitchChannels: [] }] })).toThrow(/non-empty/);
    expect(() => parseGuildConfig({ guilds: [{ ...valid.guilds[0], twitchChannels: ["https://twitch.tv/foo"] }] })).toThrow(/Twitch login/);
    expect(() => parseGuildConfig({ guilds: [{ ...valid.guilds[0], twitchChannels: [""] }] })).toThrow(/Twitch login/);
  });

  it("removes duplicate Twitch logins in one guild", () => {
    const config = parseGuildConfig({ guilds: [{ ...valid.guilds[0], twitchChannels: ["abc", "ABC"] }] });
    expect(config.guilds[0]?.twitchChannels).toEqual(["abc"]);
  });
});
