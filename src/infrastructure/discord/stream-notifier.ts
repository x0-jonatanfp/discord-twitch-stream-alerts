import { EmbedBuilder, type Client } from "discord.js";
import type { ChannelProfile, LiveStream } from "../../domain/entities/stream.js";
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
      await channel.send({
        content: `@everyone, **${stream.broadcasterLogin}** está ahora en directo: ${stream.url}`,
        embeds: [buildStreamEmbed(stream)],
        allowedMentions: { parse: ["everyone"] },
      });
      logger.info(`Posted Twitch live alert for ${stream.broadcasterLogin} in guild ${guildId}`);
    },
  };
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
      `🕒 **En directo desde:** <t:${Math.floor(new Date(stream.startedAt).getTime() / 1000)}:R>`,
    ].join("\n"));

  if (stream.thumbnailUrl) embed.setImage(stream.thumbnailUrl);
  return embed;
}

export function buildProfileEmbed(profile: ChannelProfile): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x9146ff)
    .setAuthor({
      name: profile.displayName,
      ...(profile.profileImageUrl ? { iconURL: profile.profileImageUrl } : {}),
    })
    .setTitle(profile.displayName)
    .setURL(profile.url);
}
