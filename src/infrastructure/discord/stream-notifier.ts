import {
  EmbedBuilder,
  PermissionFlagsBits,
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

export function createDiscordStreamNotifier(
  client: Client,
  logger: LoggerPort,
  options: { showViewerCount?: boolean } = {},
): StreamNotifierPort {
  return {
    async notify({ guildId, channelId, stream }) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        throw new Error(`Configured Discord channel ${channelId} is unavailable or cannot receive messages`);
      }
      if (!("guildId" in channel) || channel.guildId !== guildId) {
        throw new Error(`Configured Discord channel ${channelId} does not belong to guild ${guildId}`);
      }
      const message = await channel.send({
        content: `@everyone, **${stream.broadcasterLogin}** está ahora en directo: ${stream.url}`,
        embeds: [buildStreamEmbed(stream, { showViewerCount: options.showViewerCount })],
        allowedMentions: { parse: ["everyone"] },
      });
      logger.info(`Posted Twitch live alert for ${stream.broadcasterLogin} in guild ${guildId}`);
      return { messageId: message.id };
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
    .setDescription(description.join("\n"));

  if (stream.thumbnailUrl) embed.setImage(stream.thumbnailUrl);
  return embed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
