import { describe, expect, it, vi } from "vitest";
import { buildProfileEmbed, buildStreamEmbed, createDiscordStreamNotifier } from "../src/infrastructure/discord/stream-notifier.js";
import type { ChannelProfile, LiveStream } from "../src/domain/entities/stream.js";

const profile: ChannelProfile = {
  id: "id-1", login: "streamer", displayName: "Streamer", profileImageUrl: "https://images.example/avatar.png",
  url: "https://www.twitch.tv/streamer", isLive: false,
};
const stream: LiveStream = {
  id: "stream-1", broadcasterId: "id-1", broadcasterLogin: "streamer", broadcasterName: "Streamer",
  title: "Hello Stream", categoryName: "Game", startedAt: "2025-01-02T03:04:05Z", url: "https://www.twitch.tv/streamer",
  thumbnailUrl: "https://images.example/frame.jpg", viewerCount: 1234, profileImageUrl: "https://images.example/avatar.png", isLive: true,
};

function mockClient() {
  const send = vi.fn(async (_payload: unknown) => undefined);
  const fetchChannel = vi.fn(async (channelId: string) => ({ isTextBased: () => true, send, channelId }));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { client: { channels: { fetch: fetchChannel } } as never, send, fetchChannel, logger };
}

describe("createDiscordStreamNotifier", () => {
  it("sends an everyone notice and a standard embed with avatar, linked title, and stream image", async () => {
    const mock = mockClient();
    const notifier = createDiscordStreamNotifier(mock.client, mock.logger);
    await notifier.notify({ guildId: "guild-1", channelId: "channel-1", stream });
    expect(mock.fetchChannel).toHaveBeenCalledWith("channel-1");
    const payload = mock.send.mock.calls[0]?.[0] as {
      content: string;
      embeds: Array<{ toJSON(): { title?: string; url?: string; color?: number; author?: { name: string; icon_url?: string }; image?: { url: string }; description?: string } }>;
      components?: unknown[];
      flags?: number;
      allowedMentions: { parse: string[] };
    };

    expect(payload.content).toContain("@everyone, **streamer** está ahora en directo: https://www.twitch.tv/streamer");
    expect(payload.allowedMentions).toEqual({ parse: ["everyone"] });
    expect(payload.components).toBeUndefined();
    expect(payload.flags).toBeUndefined();
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0]?.toJSON()).toMatchObject({
      title: "Hello Stream",
      url: stream.url,
      color: 0x9146ff,
      author: { name: "Streamer", icon_url: stream.profileImageUrl },
      image: { url: stream.thumbnailUrl },
      description: expect.stringContaining("**Categoría:** Game"),
    });
    expect(payload.embeds[0]?.toJSON().description).toContain("**Espectadores:** 1234");
    expect(payload.embeds[0]?.toJSON().description).toContain("<t:");
  });

  it("builds a profile embed with author avatar left and linked title", () => {
    expect(buildProfileEmbed(profile).toJSON()).toMatchObject({
      title: "Streamer",
      url: profile.url,
      author: { name: "Streamer", icon_url: profile.profileImageUrl },
    });
  });

  it("uses a safe fallback title and category and omits a missing stream image", () => {
    const incompleteStream = { ...stream, title: "", categoryName: "", thumbnailUrl: "" };
    const embed = buildStreamEmbed(incompleteStream).toJSON();
    expect(embed.title).toBe("Directo en curso");
    expect(embed.url).toBe(stream.url);
    expect(embed.description).toContain("**Categoría:** Sin categoría");
    expect(embed.image).toBeUndefined();
  });

  it("fails clearly when configured channel is absent", async () => {
    const mock = mockClient();
    mock.fetchChannel.mockResolvedValue(null as never);
    await expect(createDiscordStreamNotifier(mock.client, mock.logger).notify({ guildId: "guild-1", channelId: "missing", stream })).rejects.toThrow(/unavailable/);
  });

  it("fails clearly when fetched channel cannot send messages", async () => {
    const mock = mockClient();
    mock.fetchChannel.mockResolvedValue({ isTextBased: () => false } as never);
    await expect(createDiscordStreamNotifier(mock.client, mock.logger).notify({ guildId: "guild-1", channelId: "voice", stream })).rejects.toThrow(/cannot receive messages/);
  });
});
