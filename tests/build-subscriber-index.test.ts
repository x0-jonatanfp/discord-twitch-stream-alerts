import { describe, expect, it } from "vitest";
import { buildSubscriberIndex } from "../src/application/build-subscriber-index.js";
import type { GuildStreamSettings, TwitchChannel } from "../src/domain/entities/stream.js";

const guilds: GuildStreamSettings[] = [
  { guildId: "guild-a", alertChannelId: "alerts-a", twitchChannels: ["one", "shared"] },
  { guildId: "guild-b", alertChannelId: "alerts-b", twitchChannels: ["shared"] },
];
const channels: TwitchChannel[] = [
  { id: "id-1", login: "shared", displayName: "Shared", profileImageUrl: "shared.png", url: "https://www.twitch.tv/shared" },
  { id: "id-2", login: "one", displayName: "One", profileImageUrl: "one.png", url: "https://www.twitch.tv/one" },
];

describe("buildSubscriberIndex", () => {
  it("routes a shared Twitch channel to every subscribing guild", () => {
    const index = buildSubscriberIndex(guilds, channels);
    expect(index.broadcasterIds).toEqual(["id-2", "id-1"]);
    expect(index.subscribersByBroadcasterId.get("id-1")).toEqual([
      { guildId: "guild-a", channelId: "alerts-a" },
      { guildId: "guild-b", channelId: "alerts-b" },
    ]);
  });

  it("reports unknown logins without dropping the valid ones", () => {
    const index = buildSubscriberIndex([
      { guildId: "guild-a", alertChannelId: "alerts-a", twitchChannels: ["one", "renamed_away"] },
    ], [channels[1]!]);
    expect(index.unknownLogins).toEqual(["renamed_away"]);
    expect(index.broadcasterIds).toEqual(["id-2"]);
  });

  it("does not duplicate the same guild/channel pair", () => {
    const index = buildSubscriberIndex([
      { guildId: "guild-a", alertChannelId: "alerts-a", twitchChannels: ["one", "one"] },
    ], [channels[1]!]);
    expect(index.subscribersByBroadcasterId.get("id-2")).toEqual([
      { guildId: "guild-a", channelId: "alerts-a" },
    ]);
  });
});
