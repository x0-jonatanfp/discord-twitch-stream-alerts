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

export function createDiscordStreamNotifier(
  client: Client,
  logger: LoggerPort,
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
      await channel.send({
        content: `@everyone, **${stream.broadcasterLogin}** está ahora en directo: ${stream.url}`,
        embeds: [buildStreamEmbed(stream)],
        allowedMentions: { parse: ["everyone"] },
      });
      logger.info(`Posted Twitch live alert for ${stream.broadcasterLogin} in guild ${guildId}`);
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

export function buildStreamEmbed(stream: LiveStream): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x9146ff)
    .setAuthor({
      name: stream.broadcasterName,
      ...(stream.profileImageUrl ? { iconURL: stream.profileImageUrl } : {}),
    })
    .setTitle(stream.title || "Directo en curso")
    .setURL(stream.url)
    .setDescription([
      `🎮 **Categoría:** ${stream.categoryName || "Sin categoría"}`,
      `👁️ **Espectadores:** ${stream.viewerCount}`,
    ].join("\n"));

  if (stream.thumbnailUrl) embed.setImage(stream.thumbnailUrl);
  return embed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
