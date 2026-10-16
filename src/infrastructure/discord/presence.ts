import { ActivityType, Events, type ActivityOptions, type Client, type PresenceData } from "discord.js";
import type { AppConfig, BotActivityType } from "../config/env.js";
import type { LoggerPort } from "../../domain/ports/logger.js";

const activityTypes: Record<BotActivityType, ActivityType> = {
  Playing: ActivityType.Playing,
  Streaming: ActivityType.Streaming,
  Listening: ActivityType.Listening,
  Watching: ActivityType.Watching,
  Custom: ActivityType.Custom,
  Competing: ActivityType.Competing,
};

export function buildBotActivity(config: Pick<AppConfig, "botActivityName" | "botActivityState" | "botActivityType" | "botActivityUrl">): ActivityOptions {
  const activity: ActivityOptions = {
    name: config.botActivityName,
    type: activityTypes[config.botActivityType],
  };
  if (config.botActivityState !== null) activity.state = config.botActivityState;
  if (config.botActivityType === "Streaming" && config.botActivityUrl !== null) activity.url = config.botActivityUrl;
  return activity;
}

/** Reapplies the configured presence after gateway reconnects and when the caller refreshes it. */
export function attachPersistentPresence(
  client: Client,
  config: Pick<AppConfig, "botActivityName" | "botActivityState" | "botActivityType" | "botActivityUrl">,
  logger: Pick<LoggerPort, "warn">,
): () => void {
  const presence: PresenceData = {
    status: "online",
    activities: [buildBotActivity(config)],
  };
  const refresh = (): void => {
    if (!client.isReady()) return;
    try {
      client.user?.setPresence(presence);
    } catch (error) {
      logger.warn(`Could not reapply Discord presence: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  client.on(Events.ShardReady, refresh);
  client.on(Events.ShardResume, refresh);
  return refresh;
}
