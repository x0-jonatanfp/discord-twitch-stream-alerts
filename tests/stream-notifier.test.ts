import { readFileSync } from "node:fs";
import { PermissionFlagsBits } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THUMBNAIL_FILE_NAME,
  buildStreamEmbed,
  createDiscordStreamNotifier,
  validateDiscordChannels,
} from "../src/infrastructure/discord/stream-notifier.js";
import type { LiveStream } from "../src/domain/entities/stream.js";

const packageVersion = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }).version;
const footerText = `Announcements v${packageVersion} · por @jonatanfp_ 💜`;

const stream: LiveStream = {
  id: "stream-1", broadcasterId: "id-1", broadcasterLogin: "streamer", broadcasterName: "Streamer",
  title: "Hello Stream", categoryName: "Game", startedAt: "2025-01-02T03:04:05Z", url: "https://www.twitch.tv/streamer",
  thumbnailUrl: "https://images.example/frame.jpg", viewerCount: 1234, profileImageUrl: "https://images.example/avatar.png", isLive: true,
};

function mockClient() {
  const send = vi.fn(async (_payload: unknown) => ({ id: "message-1" }));
  const edit = vi.fn(async (_payload: unknown) => undefined);
  const fetchMessage = vi.fn(async (_messageId: string) => ({
    embeds: [{ toJSON: () => ({ title: "Hello Stream", color: 0x9146ff, footer: { text: footerText } }) }],
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

function imageResponse(init: { status?: number; type?: string; url?: string; body?: string } = {}) {
  const response = new Response(init.body ?? "jpeg-bytes", {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "image/jpeg" },
  });
  Object.defineProperty(response, "url", { value: init.url ?? "https://images.example/frame.jpg" });
  return response;
}

// By default the preview is "not available", so tests never reach the network.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => imageResponse({ type: "text/html" })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildStreamEmbed", () => {
  it("omits viewer count by default without changing other embed fields", () => {
    const embed = buildStreamEmbed(stream).toJSON();
    expect(embed.description).toBe("🎮 **Categoría:** Game");
    expect(embed.title).toBe("Hello Stream");
    expect(embed.url).toBe(stream.url);
    expect(embed.color).toBe(0x9146ff);
    expect(embed.author).toMatchObject({ name: "Streamer", icon_url: stream.profileImageUrl });
    expect(embed.image).toEqual({ url: stream.thumbnailUrl });
    expect(embed.footer).toEqual({ text: footerText });
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
    expect(payload.embeds[0]?.toJSON().footer).toEqual({ text: footerText });
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
      embeds: [{ title: "Hello Stream", color: 0x4f545c, footer: { text: footerText } }],
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

describe("attached preview", () => {
  const sleep = vi.fn(async (_milliseconds: number) => undefined);
  const notifyWith = async (fetchFn: typeof fetch, channelExtras: Record<string, unknown> = {}) => {
    const mock = mockClient();
    if (Object.keys(channelExtras).length > 0) {
      mock.fetchChannel.mockResolvedValueOnce({
        isTextBased: () => true, send: mock.send, channelId: "channel-1", guildId: "guild-1",
        messages: { fetch: mock.fetchMessage }, ...channelExtras,
      } as never);
    }
    await createDiscordStreamNotifier(
      { ...(mock.client as object), user: channelExtras.permissionsFor ? { id: "bot" } : undefined } as never,
      mock.logger,
      { fetchFn, sleep },
    ).notify({ guildId: "guild-1", channelId: "channel-1", stream });
    return mock;
  };
  type Payload = { embeds: Array<{ toJSON(): { image?: { url: string } } }>; files?: Array<{ name: string; attachment: Buffer }> };

  it("downloads the preview and attaches it so the image survives edits", async () => {
    const mock = await notifyWith(vi.fn(async () => imageResponse()) as never);
    const payload = mock.send.mock.calls[0]?.[0] as Payload;
    expect(payload.files).toHaveLength(1);
    expect(payload.files?.[0]?.name).toBe(THUMBNAIL_FILE_NAME);
    expect(payload.files?.[0]?.attachment.toString()).toBe("jpeg-bytes");
    expect(payload.embeds[0]?.toJSON().image).toEqual({ url: `attachment://${THUMBNAIL_FILE_NAME}` });
  });

  it.each([
    ["a non-image response", { type: "text/html" }],
    ["an empty body", { body: "" }],
  ])("falls back to the image URL on %s", async (_name, init) => {
    const mock = await notifyWith(vi.fn(async () => imageResponse(init)) as never);
    const payload = mock.send.mock.calls[0]?.[0] as Payload;
    expect(payload.files).toBeUndefined();
    expect(payload.embeds[0]?.toJSON().image).toEqual({ url: stream.thumbnailUrl });
    expect(mock.logger.warn).toHaveBeenCalled();
  });

  it("waits for Twitch to render the first preview and then attaches it", async () => {
    sleep.mockClear();
    const placeholder = () => imageResponse({ url: "https://static-cdn.jtvnw.net/ttv-static/404_preview-1280x720.jpg" });
    const fetchFn = vi.fn()
      .mockImplementationOnce(async () => placeholder())
      .mockImplementationOnce(async () => imageResponse({ status: 404 }))
      .mockImplementation(async () => imageResponse());
    const mock = await notifyWith(fetchFn as never);
    const payload = mock.send.mock.calls[0]?.[0] as Payload;
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(payload.files?.[0]?.attachment.toString()).toBe("jpeg-bytes");
    expect(payload.embeds[0]?.toJSON().image).toEqual({ url: `attachment://${THUMBNAIL_FILE_NAME}` });
  });

  it("posts without any image when the preview never leaves the placeholder", async () => {
    sleep.mockClear();
    const fetchFn = vi.fn(async () => imageResponse({ url: "https://static-cdn.jtvnw.net/ttv-static/404_preview-1280x720.jpg" }));
    const mock = await notifyWith(fetchFn as never);
    const payload = mock.send.mock.calls[0]?.[0] as Payload;
    expect(fetchFn).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenCalledTimes(6);
    expect(payload.files).toBeUndefined();
    expect(payload.embeds[0]?.toJSON().image).toBeUndefined();
    expect(mock.logger.warn).toHaveBeenCalledWith(expect.stringContaining("without image"));
  });

  it("falls back to the image URL when the download throws", async () => {
    const mock = await notifyWith(vi.fn(async () => { throw new Error("timeout"); }) as never);
    const payload = mock.send.mock.calls[0]?.[0] as Payload;
    expect(payload.files).toBeUndefined();
    expect(mock.logger.warn).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  });

  it("does not upload when the bot lacks Attach Files", async () => {
    const fetchFn = vi.fn(async () => imageResponse());
    const mock = await notifyWith(fetchFn as never, { permissionsFor: () => ({ has: () => false }) });
    const payload = mock.send.mock.calls[0]?.[0] as Payload;
    expect(fetchFn).not.toHaveBeenCalled();
    expect(payload.files).toBeUndefined();
    expect(mock.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Attach Files"));
  });

  it("keeps the preview on the ended embed by re-referencing the attachment", async () => {
    const mock = mockClient();
    mock.fetchMessage.mockResolvedValueOnce({
      embeds: [{ toJSON: () => ({ title: "Hello Stream", color: 0x9146ff, image: { url: "https://cdn.discordapp.com/expired" } }) }],
      attachments: { some: (fn: (a: { name: string }) => boolean) => fn({ name: THUMBNAIL_FILE_NAME }) },
      edit: mock.edit,
    } as never);
    await createDiscordStreamNotifier(mock.client, mock.logger).markStreamEnded({
      guildId: "guild-1", channelId: "channel-1", messageId: "message-1",
    });
    expect(mock.edit).toHaveBeenCalledWith({
      embeds: [{ title: "Hello Stream", color: 0x4f545c, image: { url: `attachment://${THUMBNAIL_FILE_NAME}` } }],
    });
  });

  it("warns at startup when a channel lacks Attach Files", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const has = (flag: bigint) => flag !== PermissionFlagsBits.AttachFiles;
    const client = {
      user: { id: "bot" },
      channels: { fetch: async () => ({
        isTextBased: () => true, send: () => undefined, guildId: "guild-1", permissionsFor: () => ({ has }),
      }) },
    } as never;
    await validateDiscordChannels(client, [{ guildId: "guild-1", alertChannelId: "c", twitchChannels: ["s"] }], log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Attach Files"));
    expect(log.error).not.toHaveBeenCalled();
  });

  describe("attachPreview", () => {
    const input = { guildId: "guild-1", channelId: "channel-1", messageId: "message-1", thumbnailUrl: stream.thumbnailUrl };
    const embedJson = { title: "Hello Stream", color: 0x9146ff, image: { url: stream.thumbnailUrl } };
    const messageWith = (mock: ReturnType<typeof mockClient>, extra: Record<string, unknown> = {}) =>
      mock.fetchMessage.mockResolvedValueOnce({
        embeds: [{ toJSON: () => embedJson }], edit: mock.edit, ...extra,
      } as never);

    it("attaches the real preview to a message that only hotlinks it", async () => {
      const mock = mockClient();
      messageWith(mock);
      const done = await createDiscordStreamNotifier(mock.client, mock.logger, {
        fetchFn: vi.fn(async () => imageResponse()) as never,
      }).attachPreview(input);
      expect(done).toBe(true);
      const payload = mock.edit.mock.calls[0]?.[0] as Payload;
      expect(payload.files?.[0]?.name).toBe(THUMBNAIL_FILE_NAME);
      expect(payload.embeds[0]?.toJSON?.() ?? payload.embeds[0]).toMatchObject({
        title: "Hello Stream", color: 0x9146ff, image: { url: `attachment://${THUMBNAIL_FILE_NAME}` },
      });
    });

    it("does nothing when the message already carries the preview", async () => {
      const mock = mockClient();
      messageWith(mock, { attachments: { some: () => true } });
      const fetchFn = vi.fn(async () => imageResponse());
      const done = await createDiscordStreamNotifier(mock.client, mock.logger, { fetchFn: fetchFn as never })
        .attachPreview(input);
      expect(done).toBe(true);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(mock.edit).not.toHaveBeenCalled();
    });

    it("asks to retry later while Twitch only has the placeholder", async () => {
      const mock = mockClient();
      messageWith(mock);
      const done = await createDiscordStreamNotifier(mock.client, mock.logger, {
        fetchFn: vi.fn(async () => imageResponse({ url: "https://static-cdn.jtvnw.net/ttv-static/404_preview-1280x720.jpg" })) as never,
      }).attachPreview(input);
      expect(done).toBe(false);
      expect(mock.edit).not.toHaveBeenCalled();
    });

    it("rejects a message in a channel from another guild", async () => {
      const mock = mockClient();
      mock.fetchChannel.mockResolvedValueOnce({
        isTextBased: () => true, channelId: "channel-1", guildId: "guild-2", messages: { fetch: mock.fetchMessage },
      } as never);
      await expect(createDiscordStreamNotifier(mock.client, mock.logger).attachPreview(input))
        .rejects.toThrow(/does not belong to guild/);
    });
  });
});
