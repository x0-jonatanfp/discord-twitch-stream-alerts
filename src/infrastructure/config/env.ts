import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

export type BotActivityType = "Playing" | "Streaming" | "Listening" | "Watching" | "Custom" | "Competing";

export interface AppConfig {
  discordToken: string;
  twitchClientId: string;
  twitchClientSecret: string;
  twitchUserAccessToken: string;
  twitchRefreshToken: string;
  twitchRedirectUri: string;
  botActivityType: BotActivityType;
  botActivityUrl: string | null;
  botActivityName: string;
  botActivityState: string | null;
  guildConfigPath: string;
  liveStatePath: string;
  reconcileIntervalSeconds: number;
  showViewerCount: boolean;
  twitchUserTokenExpiresAt: number | null;
  logLevel: string;
  envPath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${key}`);
  return value;
}

function parseOptionalEpoch(raw: string | null): number | null {
  if (raw === null) return null;
  const epoch = Number(raw);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new ConfigError("TWITCH_USER_TOKEN_EXPIRES_AT must be a positive Unix timestamp in milliseconds");
  return epoch;
}

function optionalEnv(env: Record<string, string | undefined>, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function parseShowViewerCount(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError("SHOW_VIEWER_COUNT must be true or false");
}

const botActivityTypes: readonly BotActivityType[] = ["Playing", "Streaming", "Listening", "Watching", "Custom", "Competing"];

function parseBotActivityType(raw: string | null): BotActivityType {
  if (raw === null) return "Custom";
  const type = botActivityTypes.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
  if (!type) throw new ConfigError(`BOT_ACTIVITY_TYPE must be one of: ${botActivityTypes.join(", ")}`);
  return type;
}

export function parseAppConfig(
  env: Record<string, string | undefined>,
  envPath = ".env",
  options: { requireDiscordToken?: boolean; requireUserTokens?: boolean; validateActivityUrl?: boolean } = {},
): AppConfig {
  const twitchRedirectUri = optionalEnv(env, "TWITCH_REDIRECT_URI") ?? "http://localhost:3000";
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(twitchRedirectUri);
  } catch {
    throw new ConfigError("TWITCH_REDIRECT_URI must be a valid URL");
  }
  if (redirectUrl.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirectUrl.hostname)) {
    throw new ConfigError("TWITCH_REDIRECT_URI must use http://localhost or http://127.0.0.1 for local OAuth");
  }

  const botActivityType = parseBotActivityType(optionalEnv(env, "BOT_ACTIVITY_TYPE"));
  const activityUrl = optionalEnv(env, "BOT_ACTIVITY_URL");
  if (botActivityType === "Streaming" && activityUrl !== null && options.validateActivityUrl !== false) {
    let url: URL;
    try {
      url = new URL(activityUrl);
    } catch {
      throw new ConfigError("BOT_ACTIVITY_URL must be a valid URL");
    }
    if (url.protocol !== "https:" || url.hostname !== "twitch.tv" && url.hostname !== "www.twitch.tv" && url.hostname !== "youtube.com" && url.hostname !== "www.youtube.com" && url.hostname !== "youtu.be") {
      throw new ConfigError("BOT_ACTIVITY_URL must be an HTTPS Twitch or YouTube URL");
    }
  }

  const redirectPort = Number(redirectUrl.port);
  if (!Number.isInteger(redirectPort) || redirectPort < 1024) {
    throw new ConfigError("TWITCH_REDIRECT_URI must include an explicit local port greater than or equal to 1024");
  }

  const showViewerCount = parseShowViewerCount(env.SHOW_VIEWER_COUNT);
  const rawInterval = optionalEnv(env, "TWITCH_RECONCILE_INTERVAL_SECONDS") ?? "60";
  const reconcileIntervalSeconds = Number(rawInterval);
  if (!Number.isInteger(reconcileIntervalSeconds) || reconcileIntervalSeconds < 15 || reconcileIntervalSeconds > 3600) {
    throw new ConfigError("TWITCH_RECONCILE_INTERVAL_SECONDS must be an integer from 15 to 3600");
  }

  return {
    discordToken: options.requireDiscordToken === false ? optionalEnv(env, "DISCORD_TOKEN") ?? "" : requireEnv(env, "DISCORD_TOKEN"),
    twitchClientId: requireEnv(env, "TWITCH_CLIENT_ID"),
    twitchClientSecret: requireEnv(env, "TWITCH_CLIENT_SECRET"),
    twitchUserAccessToken: options.requireUserTokens === false ? optionalEnv(env, "TWITCH_USER_ACCESS_TOKEN") ?? "" : requireEnv(env, "TWITCH_USER_ACCESS_TOKEN"),
    twitchRefreshToken: options.requireUserTokens === false ? optionalEnv(env, "TWITCH_REFRESH_TOKEN") ?? "" : requireEnv(env, "TWITCH_REFRESH_TOKEN"),
    twitchRedirectUri,
    botActivityType,
    botActivityUrl: activityUrl,
    botActivityName: optionalEnv(env, "BOT_ACTIVITY_NAME") ?? "server status",
    botActivityState: optionalEnv(env, "BOT_ACTIVITY_STATE"),
    guildConfigPath: resolve(optionalEnv(env, "GUILD_CONFIG_PATH") ?? "config/guilds.json"),
    liveStatePath: resolve(optionalEnv(env, "LIVE_STATE_PATH") ?? "data/live-state.json"),
    reconcileIntervalSeconds,
    showViewerCount,
    twitchUserTokenExpiresAt: parseOptionalEpoch(optionalEnv(env, "TWITCH_USER_TOKEN_EXPIRES_AT")),
    logLevel: optionalEnv(env, "LOG_LEVEL") ?? "info",
    envPath: resolve(envPath),
  };
}

export function loadAppConfig(
  envPath = ".env",
  options: { requireDiscordToken?: boolean; requireUserTokens?: boolean; validateActivityUrl?: boolean } = {},
): AppConfig {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = dotenv.parse(readFileSync(envPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(`Cannot read environment file ${envPath}`);
    }
  }
  return parseAppConfig({ ...fileEnv, ...process.env }, envPath, options);
}
