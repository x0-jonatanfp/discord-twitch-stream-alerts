import { readFileSync } from "node:fs";
import {
  EmbedBuilder,
  PermissionFlagsBits,
  Routes,
  type Client,
} from "discord.js";
import type {
  GuildStreamSettings,
  LiveStream,
} from "../../domain/entities/stream.js";
import type { StreamNotifierPort } from "../../domain/ports/stream-notifier.js";
import type { LoggerPort } from "../../domain/ports/logger.js";

/** Twitch purple, used while the broadcast is live. */
export const LIVE_EMBED_COLOR = 0x9146ff;
/** Discord's default embed gray, used once the broadcast has ended. */
export const ENDED_EMBED_COLOR = 0x4f545c;

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { version: string };

/** Name of the preview attached to the alert so the image survives later edits. */
export const THUMBNAIL_FILE_NAME = "preview.jpg";
const THUMBNAIL_TIMEOUT_MS = 10_000;

/** Twitch needs a while after going live to render the first preview. */
const PREVIEW_RETRIES = 6;
const PREVIEW_RETRY_DELAY_MS = 15_000;

type ThumbnailResult =
  | { kind: "ready"; bytes: Buffer }
  | { kind: "pending" }
  | { kind: "failed" };

/**
 * Downloads the live preview so it can be attached to the message. A hotlinked
 * Twitch preview is re-resolved by Discord when the message is edited, and once
 * the channel is offline (or right after going live) Twitch answers with a
 * generic 404 placeholder: the same picture for every broadcast. "pending"
 * means exactly that placeholder; "failed" is any other problem.
 */
async function downloadThumbnail(
  url: string,
  fetchFn: typeof fetch,
  logger: LoggerPort,
): Promise<ThumbnailResult> {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS) });
    if (!response.ok || response.url.includes("404_preview")) return { kind: "pending" };
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      logger.warn(`Twitch preview is not an image (${contentType || "no content-type"}); posting alert with the image URL`);
      return { kind: "failed" };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      logger.warn("Twitch preview came back empty; posting alert with the image URL");
      return { kind: "failed" };
    }
    return { kind: "ready", bytes };
  } catch (error) {
    logger.warn(`Could not download Twitch preview: ${errorMessage(error)}; posting alert with the image URL`);
    return { kind: "failed" };
  }
}

async function waitForThumbnail(
  url: string,
  fetchFn: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  logger: LoggerPort,
): Promise<ThumbnailResult> {
  let result = await downloadThumbnail(url, fetchFn, logger);
  for (let attempt = 0; attempt < PREVIEW_RETRIES && result.kind === "pending"; attempt += 1) {
    await sleep(PREVIEW_RETRY_DELAY_MS);
    result = await downloadThumbnail(url, fetchFn, logger);
  }
  return result;
}

export function createDiscordStreamNotifier(
  client: Client,
  logger: LoggerPort,
  options: {
    showViewerCount?: boolean;
    fetchFn?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): StreamNotifierPort {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  return {
    async notify({ guildId, channelId, stream }) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        throw new Error(`Configured Discord channel ${channelId} is unavailable or cannot receive messages`);
      }
      if (!("guildId" in channel) || channel.guildId !== guildId) {
        throw new Error(`Configured Discord channel ${channelId} does not belong to guild ${guildId}`);
      }
      const embed = buildStreamEmbed(stream, { showViewerCount: options.showViewerCount });
      // Without Attach Files the upload would reject the whole alert, so fall back to the URL.
      const user = client.user;
      const canAttach = !user || !("permissionsFor" in channel)
        || (channel.permissionsFor(user)?.has(PermissionFlagsBits.AttachFiles) ?? false);
      if (!canAttach) logger.warn(`Missing Attach Files permission in channel ${channelId}; posting alert with the image URL`);
      const preview: ThumbnailResult = stream.thumbnailUrl && canAttach
        ? await waitForThumbnail(stream.thumbnailUrl, fetchFn, sleep, logger)
        : { kind: "failed" };
      const thumbnail = preview.kind === "ready" ? preview.bytes : undefined;
      if (thumbnail) {
        embed.setImage(`attachment://${THUMBNAIL_FILE_NAME}`);
      } else if (preview.kind === "pending") {
        // Hotlinking now would make Discord cache Twitch's generic placeholder.
        embed.setImage(null);
        logger.warn(`Twitch preview for ${stream.broadcasterLogin} was not ready after ${PREVIEW_RETRIES} retries; posting alert without image`);
      }
      const message = await channel.send({
        content: `@everyone, **${stream.broadcasterLogin}** está ahora en directo: ${stream.url}`,
        embeds: [embed],
        ...(thumbnail ? { files: [{ attachment: thumbnail, name: THUMBNAIL_FILE_NAME }] } : {}),
        allowedMentions: { parse: ["everyone"] },
      });
      logger.info(`Posted Twitch live alert for ${stream.broadcasterLogin} in guild ${guildId}`);
      return { messageId: message.id };
    },
    async refreshPreview({ guildId, channelId, messageId, thumbnailUrl }) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) {
        throw new Error(`Configured Discord channel ${channelId} is unavailable or cannot hold messages`);
      }
      if (!("guildId" in channel) || channel.guildId !== guildId) {
        throw new Error(`Configured Discord channel ${channelId} does not belong to guild ${guildId}`);
      }
      const user = client.user;
      if (user && "permissionsFor" in channel
        && !channel.permissionsFor(user)?.has(PermissionFlagsBits.AttachFiles)) {
        return;
      }
      const preview = await downloadThumbnail(thumbnailUrl, fetchFn, logger);
      if (preview.kind !== "ready") return;
      const message = await channel.messages.fetch(messageId);
      const embed = message.embeds[0];
      if (!embed) return;
      // Raw REST call: the upload must be declared in `attachments` (id + filename)
      // or Discord drops it, and discord.js does not send the filename on edits.
      await client.rest.patch(Routes.channelMessage(channelId, messageId), {
        body: {
          embeds: [{ ...embed.toJSON(), image: { url: `attachment://${THUMBNAIL_FILE_NAME}` } }],
          attachments: [{ id: 0, filename: THUMBNAIL_FILE_NAME }],
        },
        files: [{ name: THUMBNAIL_FILE_NAME, data: preview.bytes, contentType: "image/jpeg" }],
      });
      logger.info(`Refreshed the live preview of alert ${messageId} in guild ${guildId}`);
    },
    async markStreamEnded({ guildId, channelId, messageId }) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) {
        throw new Error(`Configured Discord channel ${channelId} is unavailable or cannot hold messages`);
      }
      if (!("guildId" in channel) || channel.guildId !== guildId) {
        throw new Error(`Configured Discord channel ${channelId} does not belong to guild ${guildId}`);
      }
      const message = await channel.messages.fetch(messageId);
      const embed = message.embeds[0];
      if (!embed) {
        logger.warn(`Alert message ${messageId} in channel ${channelId} has no embed to mark as ended`);
        return;
      }
      // Final edit: only the color changes. The image stays as the last refresh
      // left it (its URL is at most a few minutes old, so it is still valid).
      await message.edit({ embeds: [{ ...embed.toJSON(), color: ENDED_EMBED_COLOR }] });
      logger.info(`Marked Twitch live alert ${messageId} as ended in guild ${guildId}`);
    },
  };
}

/**
 * Checks every configured channel after Discord is ready. A bad channel ID or
 * missing permission is otherwise only discovered when a streamer goes live.
 */
export async function validateDiscordChannels(
  client: Client,
  guilds: readonly GuildStreamSettings[],
  logger: LoggerPort,
): Promise<void> {
  for (const guild of guilds) {
    try {
      const channel = await client.channels.fetch(guild.alertChannelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        throw new Error("channel is missing or cannot receive messages");
      }
      if (!("guildId" in channel) || channel.guildId !== guild.guildId) {
        throw new Error(`channel belongs to guild ${"guildId" in channel ? channel.guildId : "unknown"}, not ${guild.guildId}`);
      }

      const user = client.user;
      if (user && "permissionsFor" in channel) {
        const permissions = channel.permissionsFor(user);
        if (
          !permissions?.has(PermissionFlagsBits.ViewChannel)
          || !permissions.has(PermissionFlagsBits.SendMessages)
          || !permissions.has(PermissionFlagsBits.EmbedLinks)
        ) {
          throw new Error("missing View Channel, Send Messages, or Embed Links permission");
        }
      }

      if (user && "permissionsFor" in channel && !channel.permissionsFor(user)?.has(PermissionFlagsBits.AttachFiles)) {
        logger.warn(`Discord alert channel ${guild.alertChannelId} lacks Attach Files: previews will be hotlinked and vanish when the alert is marked as ended`);
      }

      logger.info(`Validated Discord alert channel ${guild.alertChannelId} for guild ${guild.guildId}`);
    } catch (error) {
      logger.error(
        `Discord alert channel ${guild.alertChannelId} for guild ${guild.guildId} is not usable: ${errorMessage(error)}`,
      );
    }
  }
}

export function buildStreamEmbed(
  stream: LiveStream,
  options: { showViewerCount?: boolean } = {},
): EmbedBuilder {
  const description = [`🎮 **Categoría:** ${stream.categoryName || "Sin categoría"}`];
  if (options.showViewerCount === true) {
    description.push(`👁️ **Espectadores:** ${stream.viewerCount}`);
  }

  const embed = new EmbedBuilder()
    .setColor(LIVE_EMBED_COLOR)
    .setAuthor({
      name: stream.broadcasterName,
      ...(stream.profileImageUrl ? { iconURL: stream.profileImageUrl } : {}),
    })
    .setTitle(stream.title || "Directo en curso")
    .setURL(stream.url)
    .setDescription(description.join("\n"))
    .setFooter({ text: `Announcements v${packageJson.version} · por @jonatanfp_ 💜` });

  if (stream.thumbnailUrl) embed.setImage(stream.thumbnailUrl);
  return embed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
