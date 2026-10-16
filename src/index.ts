import { Client, Events, GatewayIntentBits } from "discord.js";
import { pathToFileURL } from "node:url";
import { createLiveStreamReconciler } from "./application/reconcile-live-streams.js";
import { loadAppConfig } from "./infrastructure/config/env.js";
import { createGuildConfigAdapter } from "./infrastructure/config/guild-config.js";
import { createDiscordStreamNotifier } from "./infrastructure/discord/stream-notifier.js";
import { attachPersistentPresence } from "./infrastructure/discord/presence.js";
import { createLogger } from "./infrastructure/logging/console-logger.js";
import { createJsonLiveStateStore } from "./infrastructure/persistence/json-live-state-store.js";
import { EventSubClient } from "./infrastructure/twitch/eventsub-client.js";
import { TwitchApi } from "./infrastructure/twitch/twitch-api.js";
import type { LiveStream } from "./domain/entities/stream.js";

export async function main(): Promise<void> {
  let config;
  try {
    config = loadAppConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid bot configuration");
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);
  let guildConfig;
  try {
    guildConfig = await createGuildConfigAdapter(config.guildConfigPath).load();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : "Invalid guild configuration");
    process.exitCode = 1;
    return;
  }
  if (guildConfig.guilds.length === 0) {
    logger.error("Guild configuration has no guild entries");
    process.exitCode = 1;
    return;
  }

  const twitch = new TwitchApi(config);
  let channels;
  try {
    const configuredLogins = [...new Set(guildConfig.guilds.flatMap((guild) => guild.twitchChannels))];
    channels = await twitch.resolveChannels(configuredLogins);
  } catch (error) {
    logger.error(`Could not resolve configured Twitch channels: ${safeError(error)}`);
    process.exitCode = 1;
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const notifier = createDiscordStreamNotifier(client, logger);
  const refreshPresence = attachPersistentPresence(client, config, logger);
  const stateStore = createJsonLiveStateStore(config.liveStatePath);
  const reconciler = createLiveStreamReconciler({
    config: guildConfig,
    twitch,
    notifier,
    stateStore,
    logger,
  });

  let reconcileTimer: NodeJS.Timeout | undefined;
  let eventSub: EventSubClient | undefined;
  let shuttingDown = false;

  client.once(Events.ClientReady, () => {
    const user = client.user;
    if (!user) return;
    refreshPresence();

    eventSub = new EventSubClient({
      broadcasterIds: channels.map((channel) => channel.id),
      twitch,
      logger,
      onSessionReady: async () => {
        await reconciler.reconcile();
      },
      onStreamOnline: async (event) => {
        let stream: LiveStream | undefined;
        try {
          const [liveStream] = await twitch.getLiveStreams([event.broadcaster_user_id]);
          if (liveStream) stream = liveStream;
        } catch (error) {
          logger.warn(`Could not fetch stream details for ${event.broadcaster_user_login}: ${safeError(error)}`);
        }
        if (!stream) {
          const channel = channels.find((candidate) => candidate.id === event.broadcaster_user_id);
          if (!channel) {
            logger.warn(`Skipping Twitch alert for ${event.broadcaster_user_login}: broadcaster is not configured`);
            return;
          }
          stream = {
            id: event.id,
            broadcasterId: event.broadcaster_user_id,
            broadcasterLogin: event.broadcaster_user_login.toLowerCase(),
            broadcasterName: event.broadcaster_user_name,
            title: event.title,
            categoryName: event.category_name ?? "",
            startedAt: event.started_at,
            url: channel.url,
            thumbnailUrl: "",
            viewerCount: 0,
            profileImageUrl: channel.profileImageUrl,
            isLive: true,
          };
        }
        await reconciler.handleOnlineEvent(stream);
      },
    });
    eventSub.start();
    reconcileTimer = setInterval(() => {
      void reconciler.reconcile().catch((error: unknown) => {
        logger.error(`Twitch stream reconciliation failed: ${safeError(error)}`);
      }).finally(refreshPresence);
    }, config.reconcileIntervalSeconds * 1000);
    reconcileTimer.unref();
    logger.info(`Discord connected as ${user.tag}; watching ${channels.length} Twitch channel(s) across ${guildConfig.guilds.length} guild(s)`);
  });

  client.on("error", (error) => logger.error(`Discord client error: ${error.message}`));
  client.on("warn", (warning) => logger.warn(`Discord client warning: ${warning}`));

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down`);
    if (reconcileTimer) clearInterval(reconcileTimer);
    await eventSub?.stop();
    await client.destroy();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await client.login(config.discordToken);
  } catch (error) {
    logger.error(`Discord login failed: ${safeError(error)}`);
    process.exitCode = 1;
    await eventSub?.stop();
    client.destroy();
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
