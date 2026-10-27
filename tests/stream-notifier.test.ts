import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildStreamEmbed,
  createDiscordStreamNotifier,
  validateDiscordChannels,
} from "../src/infrastructure/discord/stream-notifier.js";
import type { LiveStream } from "../src/domain/entities/stream.js";

const packageVersion = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }).version;

const stream: LiveStream = {
  id: "stream-1", broadcasterId: "id-1", broadcasterLogin: "streamer", broadcasterName: "Streamer",
  title: "Hello Stream", categoryName: "Game", startedAt: "2025-01-02T03:04:05Z", url: "https://www.twitch.tv/streamer",
  thumbnailUrl: "https://images.example/frame.jpg", viewerCount: 1234, profileImageUrl: "https://images.example/avatar.png", isLive: true,
};

function mockClient() {
  const send = vi.fn(async (_payload: unknown) => ({ id: "message-1" }));
  const edit = vi.fn(async (_payload: unknown) => undefined);
  const fetchMessage = vi.fn(async (_messageId: string) => ({
    embeds: [{ toJSON: () => ({ title: "Hello Stream", color: 0x9146ff, footer: { text: `v${packageVersion}` } }) }],
    edit,
  }));
  const fetchChannel = vi.fn(async (channelId: string) => ({
    isTextBased: () => true,
    send,
    channelId,
    guildId: "guild-1",
    messages: { fetch: fetchMessage },
  }));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    client: { channels: { fetch: fetchChannel } } as never,
    send,
    edit,
    fetchMessage,
    fetchChannel,
    logger,
  };
}

describe("buildStreamEmbed", () => {
  it("omits viewer count by default without changing other embed fields", () => {
    const embed = buildStreamEmbed(stream).toJSON();
    expect(embed.description).toBe("🎮 **Categoría:** Game");
    expect(embed.title).toBe("Hello Stream");
    expect(embed.url).toBe(stream.url);
    expect(embed.color).toBe(0x9146ff);
    expect(embed.author).toMatchObject({ name: "Streamer", icon_url: stream.profileImageUrl });
    expect(embed.image).toEqual({ url: stream.thumbnailUrl });
    expect(embed.footer).toEqual({ text: `v${packageVersion}` });
  });

  it("includes viewer count when explicitly enabled", () => {
    expect(buildStreamEmbed(stream, { showViewerCount: true }).toJSON().description)
      .toBe(`🎮 **Categoría:** Game\n👁️ **Espectadores:** 1234`);
  });
});

describe("createDiscordStreamNotifier", () => {
  it("sends viewer count when the notifier option is enabled", async () => {
    const mock = mockClient();
    const notifier = createDiscordStreamNotifier(mock.client, mock.logger, { showViewerCount: true });
    await notifier.notify({ guildId: "guild-1", channelId: "channel-1", stream });
    const payload = mock.send.mock.calls[0]?.[0] as {
      embeds: Array<{ toJSON(): { description?: string } }>;
    };
    expect(payload.embeds[0]?.toJSON().description).toContain("👁️ **Espectadores:** 1234");
  });

  it("sends an everyone notice and a standard embed with avatar, linked title, and stream image", async () => {
    const mock = mockClient();
    const notifier = createDiscordStreamNotifier(mock.client, mock.logger);
    await expect(notifier.notify({ guildId: "guild-1", channelId: "channel-1", stream }))
      .resolves.toEqual({ messageId: "message-1" });
    expect(mock.fetchChannel).toHaveBeenCalledWith("channel-1");
    const payload = mock.send.mock.calls[0]?.[0] as {
      content: string;
      embeds: Array<{ toJSON(): { title?: string; url?: string; color?: number; author?: { name: string; icon_url?: string }; image?: { url: string }; description?: string; footer?: { text: string } } }>;
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
    expect(payload.embeds[0]?.toJSON().description).not.toContain("**Espectadores:**");
    expect(payload.embeds[0]?.toJSON().footer).toEqual({ text: `v${packageVersion}` });
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

  it("rejects a channel that belongs to another guild", async () => {
    const mock = mockClient();
    mock.fetchChannel.mockResolvedValue({
      isTextBased: () => true,
      send: mock.send,
      channelId: "channel-1",
      guildId: "guild-2",
    } as never);
    await expect(
      createDiscordStreamNotifier(mock.client, mock.logger).notify({ guildId: "guild-1", channelId: "channel-1", stream }),
    ).rejects.toThrow(/does not belong to guild/);
    expect(mock.send).not.toHaveBeenCalled();
  });

  it("validates configured channels at startup and reports unusable ones", async () => {
    const permissions = { has: vi.fn(() => true) };
    const client = {
      user: { id: "bot" },
      channels: {
        fetch: vi.fn(async (channelId: string) => channelId === "ok"
          ? { isTextBased: () => true, send: vi.fn(), guildId: "guild-1", permissionsFor: () => permissions }
          : { isTextBased: () => true, send: vi.fn(), guildId: "guild-2", permissionsFor: () => permissions }),
      },
    } as never;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await validateDiscordChannels(client, [
      { guildId: "guild-1", alertChannelId: "ok", twitchChannels: ["streamer"] },
      { guildId: "guild-1", alertChannelId: "wrong-guild", twitchChannels: ["streamer"] },
    ], log);

    expect(log.info).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("wrong-guild"));
  });

  it("recolors the posted embed when the stream ends", async () => {
    const mock = mockClient();
    await createDiscordStreamNotifier(mock.client, mock.logger).markStreamEnded({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
    });
    expect(mock.fetchMessage).toHaveBeenCalledWith("message-1");
    expect(mock.edit).toHaveBeenCalledWith({
      embeds: [{ title: "Hello Stream", color: 0x4f545c, footer: { text: `v${packageVersion}` } }],
    });
    expect(mock.logger.info).toHaveBeenCalledWith(expect.stringContaining("as ended"));
  });

  it("skips messages that have no embed to recolor", async () => {
    const mock = mockClient();
    mock.fetchMessage.mockResolvedValueOnce({ embeds: [], edit: mock.edit } as never);
    await createDiscordStreamNotifier(mock.client, mock.logger).markStreamEnded({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
    });
    expect(mock.edit).not.toHaveBeenCalled();
    expect(mock.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no embed"));
  });

  it("rejects marking an alert in a channel from another guild", async () => {
    const mock = mockClient();
    mock.fetchChannel.mockResolvedValueOnce({
      isTextBased: () => true,
      send: mock.send,
      channelId: "channel-1",
      guildId: "guild-2",
      messages: { fetch: mock.fetchMessage },
    } as never);
    await expect(createDiscordStreamNotifier(mock.client, mock.logger).markStreamEnded({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
    })).rejects.toThrow(/does not belong to guild/);
    expect(mock.edit).not.toHaveBeenCalled();
  });

  it("propagates a missing message so the reconciler can log it", async () => {
    const mock = mockClient();
    mock.fetchMessage.mockRejectedValueOnce(new Error("Unknown Message"));
    await expect(createDiscordStreamNotifier(mock.client, mock.logger).markStreamEnded({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "missing",
    })).rejects.toThrow("Unknown Message");
  });
});
