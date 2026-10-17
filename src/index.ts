import { Client, Events, GatewayIntentBits } from "discord.js";
import { pathToFileURL } from "node:url";
import { buildSubscriberIndex } from "./application/build-subscriber-index.js";
import { createLiveStreamReconciler } from "./application/reconcile-live-streams.js";
import type {
  GuildStreamSettings,
  LiveStream,
  StreamOnlineEvent,
  StreamSubscriptionConfig,
  TwitchChannel,
} from "./domain/entities/stream.js";
import type { LiveStateStorePort } from "./domain/ports/live-state-store.js";
import type { LoggerPort } from "./domain/ports/logger.js";
import type { StreamNotifierPort } from "./domain/ports/stream-notifier.js";
import type { TwitchStreamsPort } from "./domain/ports/twitch-streams.js";
import { loadAppConfig, type AppConfig } from "./infrastructure/config/env.js";
import { createGuildConfigAdapter } from "./infrastructure/config/guild-config.js";
import {
  createDiscordStreamNotifier,
  validateDiscordChannels,
} from "./infrastructure/discord/stream-notifier.js";
import { attachPersistentPresence } from "./infrastructure/discord/presence.js";
import { createLogger } from "./infrastructure/logging/console-logger.js";
import { createJsonLiveStateStore } from "./infrastructure/persistence/json-live-state-store.js";
import { EventSubClient } from "./infrastructure/twitch/eventsub-client.js";
import { TwitchApi } from "./infrastructure/twitch/twitch-api.js";

export interface BotClientPort {
  user: { tag: string } | null;
  once(event: string, listener: () => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
}

export interface IntervalHandle {
  unref?(): unknown;
}

export interface EventSubPort {
  start(): void;
  stop(): Promise<void>;
}

export interface BotEventSubOptions {
  broadcasterIds: string[];
  onSessionReady: () => Promise<void>;
  onStreamOnline: (event: StreamOnlineEvent) => Promise<void>;
}

export type CreateEventSub = (
  options: BotEventSubOptions,
  context: { twitch: TwitchStreamsPort; logger: LoggerPort },
) => EventSubPort;

export interface CreateBotDependencies {
  config: AppConfig;
  guildConfig: StreamSubscriptionConfig;
  logger: LoggerPort;
  twitch: TwitchStreamsPort;
  channels: readonly TwitchChannel[];
  client: BotClientPort;
  notifier: StreamNotifierPort;
  refreshPresence: () => void;
  stateStore: LiveStateStorePort;
  validateChannels: (
    client: BotClientPort,
    guilds: readonly GuildStreamSettings[],
    logger: LoggerPort,
  ) => Promise<void>;
  createEventSub: CreateEventSub;
  setIntervalFn?: (callback: () => void, milliseconds: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

export interface BotRuntime {
  start(): Promise<void>;
  shutdown(signal: string): Promise<void>;
}

export class BotConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotConfigurationError";
  }
}

export interface MainDependencies {
  loadConfig: () => AppConfig;
  loadGuildConfig: (path: string) => Promise<StreamSubscriptionConfig>;
  createLogger: (levelName: string) => LoggerPort;
  createTwitch: (config: AppConfig) => TwitchStreamsPort;
  createClient: () => BotClientPort;
  createNotifier: (client: BotClientPort, logger: LoggerPort) => StreamNotifierPort;
  attachPresence: (client: BotClientPort, config: AppConfig, logger: LoggerPort) => () => void;
  createStateStore: (path: string, logger: LoggerPort) => LiveStateStorePort;
  validateChannels: CreateBotDependencies["validateChannels"];
  createEventSub: CreateEventSub;
  registerSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
  sleep: (milliseconds: number) => Promise<void>;
  resolveAttempts: number;
  resolveBaseDelayMs: number;
}

export const defaultMainDependencies: MainDependencies = {
  loadConfig: () => loadAppConfig(),
  loadGuildConfig: (path) => createGuildConfigAdapter(path).load(),
  createLogger: (levelName) => createLogger(levelName),
  createTwitch: (config) => new TwitchApi(config),
  createClient: () => new Client({ intents: [GatewayIntentBits.Guilds] }) as unknown as BotClientPort,
  createNotifier: (client, logger) => createDiscordStreamNotifier(client as unknown as Client, logger),
  attachPresence: (client, config, logger) => attachPersistentPresence(client as unknown as Client, config, logger),
  createStateStore: (path, logger) => createJsonLiveStateStore(path, logger),
  validateChannels: (client, guilds, logger) => validateDiscordChannels(client as unknown as Client, guilds, logger),
  createEventSub: (options, context) => new EventSubClient({
    ...options,
    twitch: context.twitch,
    logger: context.logger,
  }),
  registerSignal: (signal, handler) => {
    process.once(signal, handler);
  },
  sleep: (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
  resolveAttempts: 3,
  resolveBaseDelayMs: 1_000,
};

export async function resolveChannelsWithRetry(
  twitch: Pick<TwitchStreamsPort, "resolveChannels">,
  logins: readonly string[],
  logger: Pick<LoggerPort, "warn">,
  options: { attempts: number; baseDelayMs: number; sleep: (milliseconds: number) => Promise<void> },
): Promise<TwitchChannel[]> {
  const attempts = Math.max(1, options.attempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await twitch.resolveChannels([...logins]);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delay = options.baseDelayMs * 2 ** (attempt - 1);
      logger.warn(
        `Could not resolve Twitch channels (attempt ${attempt}/${attempts}): ${errorMessage(error)}; retrying in ${delay} ms`,
      );
      await options.sleep(delay);
    }
  }

  throw lastError;
}

export function createBot(dependencies: CreateBotDependencies): BotRuntime {
  const {
    config,
    guildConfig,
    logger,
    twitch,
    channels,
    client,
    notifier,
    refreshPresence,
    stateStore,
  } = dependencies;

  const subscriptionIndex = buildSubscriberIndex(guildConfig.guilds, channels);
  if (subscriptionIndex.unknownLogins.length > 0) {
    logger.warn(
      `Ignoring unresolved Twitch login(s): ${subscriptionIndex.unknownLogins.join(", ")}; check config/guilds.json`,
    );
  }
  if (subscriptionIndex.broadcasterIds.length === 0) {
    throw new BotConfigurationError(
      "None of the configured Twitch channels could be resolved; check config/guilds.json and the Twitch application",
    );
  }
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));

  const reconciler = createLiveStreamReconciler({
    subscribersByBroadcasterId: subscriptionIndex.subscribersByBroadcasterId,
    twitch,
    notifier,
    stateStore,
    logger,
  });

  const setIntervalFn = dependencies.setIntervalFn ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const clearIntervalFn = dependencies.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

  let eventSub: EventSubPort | undefined;
  let reconcileTimer: IntervalHandle | undefined;
  let shuttingDown = false;

  async function startApplication(): Promise<void> {
    const user = client.user;
    if (!user) return;
    refreshPresence();
    await dependencies.validateChannels(client, guildConfig.guilds, logger);
    if (shuttingDown) return;

    eventSub = dependencies.createEventSub({
      broadcasterIds: subscriptionIndex.broadcasterIds,
      onSessionReady: async () => {
        await reconciler.reconcile();
      },
      onStreamOnline: async (event) => {
        let stream: LiveStream | undefined;
        try {
          const [liveStream] = await twitch.getLiveStreams([event.broadcaster_user_id]);
          if (liveStream) stream = liveStream;
        } catch (error) {
          logger.warn(`Could not fetch stream details for ${event.broadcaster_user_login}: ${errorMessage(error)}`);
        }
        if (!stream) {
          const channel = channelsById.get(event.broadcaster_user_id);
          if (!channel) {
            logger.warn(`Skipping Twitch alert for ${event.broadcaster_user_login}: broadcaster is not configured`);
            return;
          }
          stream = {
            id: event.id,
            broadcasterId: event.broadcaster_user_id,
            broadcasterLogin: event.broadcaster_user_login.toLowerCase(),
            broadcasterName: event.broadcaster_user_name,
            // stream.online does not carry title/category; use the safe defaults
            // until a Helix lookup succeeds.
            title: "",
            categoryName: "",
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
    }, { twitch, logger });
    eventSub.start();
    reconcileTimer = setIntervalFn(() => {
      void reconciler.reconcile().catch((error: unknown) => {
        logger.error(`Twitch stream reconciliation failed: ${errorMessage(error)}`);
      }).finally(refreshPresence);
    }, config.reconcileIntervalSeconds * 1000);
    reconcileTimer.unref?.();
    logger.info(`Discord connected as ${user.tag}; watching ${subscriptionIndex.broadcasterIds.length} Twitch channel(s) across ${guildConfig.guilds.length} guild(s)`);
  }

  async function start(): Promise<void> {
    client.once(Events.ClientReady, () => {
      void startApplication().catch((error: unknown) => {
        logger.error(`Bot initialization failed: ${errorMessage(error)}`);
      });
    });
    client.on("error", (error) => logger.error(`Discord client error: ${errorMessage(error)}`));
    client.on("warn", (warning) => logger.warn(`Discord client warning: ${String(warning)}`));

    try {
      await client.login(config.discordToken);
    } catch (error) {
      logger.error(`Discord login failed: ${errorMessage(error)}`);
      process.exitCode = 1;
      await eventSub?.stop();
      await client.destroy();
    }
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down`);
    if (reconcileTimer) clearIntervalFn(reconcileTimer);
    await eventSub?.stop();
    await client.destroy();
  }

  return { start, shutdown };
}

export async function main(overrides: Partial<MainDependencies> = {}): Promise<void> {
  const dependencies: MainDependencies = { ...defaultMainDependencies, ...overrides };

  let config: AppConfig;
  try {
    config = dependencies.loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid bot configuration");
    process.exitCode = 1;
    return;
  }

  const logger = dependencies.createLogger(config.logLevel);
  let guildConfig: StreamSubscriptionConfig;
  try {
    guildConfig = await dependencies.loadGuildConfig(config.guildConfigPath);
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

  const twitch = dependencies.createTwitch(config);
  const configuredLogins = [...new Set(guildConfig.guilds.flatMap((guild) => guild.twitchChannels))];
  let channels: TwitchChannel[];
  try {
    channels = await resolveChannelsWithRetry(twitch, configuredLogins, logger, {
      attempts: dependencies.resolveAttempts,
      baseDelayMs: dependencies.resolveBaseDelayMs,
      sleep: dependencies.sleep,
    });
  } catch (error) {
    logger.error(`Could not resolve configured Twitch channels: ${errorMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  const client = dependencies.createClient();
  const notifier = dependencies.createNotifier(client, logger);
  const refreshPresence = dependencies.attachPresence(client, config, logger);
  const stateStore = dependencies.createStateStore(config.liveStatePath, logger);

  let bot: BotRuntime;
  try {
    bot = createBot({
      config,
      guildConfig,
      logger,
      twitch,
      channels,
      client,
      notifier,
      refreshPresence,
      stateStore,
      validateChannels: dependencies.validateChannels,
      createEventSub: dependencies.createEventSub,
    });
  } catch (error) {
    logger.error(error instanceof Error ? error.message : "Invalid bot configuration");
    process.exitCode = 1;
    return;
  }

  dependencies.registerSignal("SIGINT", () => void bot.shutdown("SIGINT"));
  dependencies.registerSignal("SIGTERM", () => void bot.shutdown("SIGTERM"));

  await bot.start();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
