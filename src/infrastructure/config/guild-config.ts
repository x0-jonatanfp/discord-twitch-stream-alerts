import { readFile } from "node:fs/promises";
import type { StreamSubscriptionConfig } from "../../domain/entities/stream.js";
import type { StreamConfigPort } from "../../domain/ports/stream-config.js";

export class GuildConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuildConfigError";
  }
}

export function parseGuildConfig(input: unknown): StreamSubscriptionConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GuildConfigError("Guild config must be an object");
  }
  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.guilds)) throw new GuildConfigError("guilds must be an array");

  const seenGuildIds = new Set<string>();
  const guilds = root.guilds.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new GuildConfigError(`guilds[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const guildId = validSnowflake(item.guildId, `guilds[${index}].guildId`);
    const alertChannelId = validSnowflake(item.alertChannelId, `guilds[${index}].alertChannelId`);
    if (seenGuildIds.has(guildId)) throw new GuildConfigError(`Duplicate guildId ${guildId}`);
    seenGuildIds.add(guildId);
    if (!Array.isArray(item.twitchChannels) || item.twitchChannels.length === 0) {
      throw new GuildConfigError(`guilds[${index}].twitchChannels must be a non-empty array`);
    }
    const twitchChannels = item.twitchChannels.map((channel, channelIndex) => {
      if (typeof channel !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(channel.trim())) {
        throw new GuildConfigError(`guilds[${index}].twitchChannels[${channelIndex}] must be a Twitch login`);
      }
      return channel.trim().toLowerCase();
    });
    return { guildId, alertChannelId, twitchChannels: [...new Set(twitchChannels)] };
  });

  return { guilds };
}

function validSnowflake(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value)) {
    throw new GuildConfigError(`${path} must be a Discord Snowflake (17-20 digits)`);
  }
  return value;
}

export function createGuildConfigAdapter(path: string): StreamConfigPort {
  return {
    async load() {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new GuildConfigError(`Missing ${path}; copy config/guilds.example.json and configure your guilds`);
        }
        if (error instanceof SyntaxError) throw new GuildConfigError(`${path} contains invalid JSON`);
        throw error;
      }
      return parseGuildConfig(parsed);
    },
  };
}
