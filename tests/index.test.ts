import { Events } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BotConfigurationError,
  createBot,
  defaultMainDependencies,
  main,
  resolveChannelsWithRetry,
  type BotClientPort,
  type BotEventSubOptions,
  type CreateBotDependencies,
  type CreateEventSub,
  type EventSubPort,
  type IntervalHandle,
  type MainDependencies,
} from "../src/index.js";
import type {
  LiveStream,
  StreamOnlineEvent,
  StreamSubscriptionConfig,
  TwitchChannel,
} from "../src/domain/entities/stream.js";
import type { LiveStateStorePort, LiveStreamState } from "../src/domain/ports/live-state-store.js";
import type { LoggerPort } from "../src/domain/ports/logger.js";
import type { StreamNotifierPort } from "../src/domain/ports/stream-notifier.js";
import type { TwitchStreamsPort } from "../src/domain/ports/twitch-streams.js";
import { ConfigError, type AppConfig } from "../src/infrastructure/config/env.js";

const config: AppConfig = {
  discordToken: "discord-token",
  twitchClientId: "client-id",
  twitchClientSecret: "client-secret",
  twitchUserAccessToken: "access",
  twitchRefreshToken: "refresh",
  twitchRedirectUri: "http://localhost:3000",
  botActivityType: "Custom",
  botActivityUrl: null,
  botActivityName: "live",
  botActivityState: null,
  guildConfigPath: "/tmp/guilds.json",
  liveStatePath: "/tmp/state.json",
  reconcileIntervalSeconds: 60,
  logLevel: "info",
  envPath: "/tmp/.env",
  twitchUserTokenExpiresAt: null,
};

const guildConfig: StreamSubscriptionConfig = {
  guilds: [{ guildId: "guild-1", alertChannelId: "channel-1", twitchChannels: ["one"] }],
};

const channel: TwitchChannel = {
  id: "101",
  login: "one",
  displayName: "One",
  profileImageUrl: "https://images.example/one.png",
  url: "https://www.twitch.tv/one",
};

const liveStream: LiveStream = {
  id: "stream-1",
  broadcasterId: "101",
  broadcasterLogin: "one",
  broadcasterName: "One",
  title: "Title",
  categoryName: "Game",
  startedAt: "2025-01-02T03:04:05Z",
  url: "https://www.twitch.tv/one",
  thumbnailUrl: "https://images.example/thumb.jpg",
  viewerCount: 10,
  profileImageUrl: "https://images.example/one.png",
  isLive: true,
};

const onlineEvent: StreamOnlineEvent = {
  id: "stream-1",
  broadcaster_user_id: "101",
  broadcaster_user_login: "One",
  broadcaster_user_name: "One",
  started_at: "2025-01-02T03:04:05Z",
};

const initialExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = initialExitCode;
  vi.restoreAllMocks();
});

function flushAsync(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createLoggerSpy(): LoggerPort {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createFakeStateStore(initial: LiveStreamState = {}) {
  const load = vi.fn(async () => initial);
  const save = vi.fn(async (_state: LiveStreamState) => {});
  const store: LiveStateStorePort = { load, save };
  return { store, load, save };
}

class FakeClient implements BotClientPort {
  user: { tag: string } | null = { tag: "bot#0001" };
  readonly onceHandlers = new Map<string, () => void>();
  readonly onHandlers = new Map<string, (...args: unknown[]) => void>();
  readonly loginCalls: string[] = [];
  destroyed = false;
  loginError: Error | null = null;

  once(event: string, listener: () => void): void {
    this.onceHandlers.set(event, listener);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.onHandlers.set(event, listener);
  }

  async login(token: string): Promise<void> {
    this.loginCalls.push(token);
    if (this.loginError) throw this.loginError;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  emitReady(): void {
    this.onceHandlers.get(Events.ClientReady)?.();
  }
}

interface CapturedEventSub extends EventSubPort {
  options: BotEventSubOptions;
  started: boolean;
  stopped: boolean;
}

function createEventSubCapture() {
  const instances: CapturedEventSub[] = [];
  const factory: CreateEventSub = (options) => {
    const instance: CapturedEventSub = {
      options,
      started: false,
      stopped: false,
      start: () => {
        instance.started = true;
      },
      stop: async () => {
        instance.stopped = true;
      },
    };
    instances.push(instance);
    return instance;
  };
  return { factory, instances };
}

function createIntervalCapture() {
  const callbacks: Array<{ callback: () => void; milliseconds: number; handle: IntervalHandle }> = [];
  const setIntervalFn = vi.fn((callback: () => void, milliseconds: number): IntervalHandle => {
    const handle: IntervalHandle = { unref: vi.fn() };
    callbacks.push({ callback, milliseconds, handle });
    return handle;
  });
  const clearIntervalFn = vi.fn((_handle: IntervalHandle) => {});
  return { setIntervalFn, clearIntervalFn, callbacks };
}

function createBotHarness(overrides: Partial<CreateBotDependencies> = {}) {
  const logger = createLoggerSpy();
  const client = new FakeClient();
  const resolveChannels = vi.fn(async (_logins: string[]) => [channel]);
  const getLiveStreams = vi.fn(async (_broadcasterIds: string[]) => [] as LiveStream[]);
  const twitch: TwitchStreamsPort = {
    resolveChannels,
    subscribeToOnline: vi.fn(async () => {}),
    getLiveStreams,
  };
  const notify = vi.fn(async (_input: { guildId: string; channelId: string; stream: LiveStream }) => ({ messageId: "message-1" }));
  const notifier: StreamNotifierPort = { notify, markStreamEnded: vi.fn(async () => {}) };
  const stateStore = createFakeStateStore();
  const eventSub = createEventSubCapture();
  const interval = createIntervalCapture();
  const validateChannels = vi.fn(async () => {});
  const refreshPresence = vi.fn();

  const dependencies: CreateBotDependencies = {
    config,
    guildConfig,
    logger,
    twitch,
    channels: [channel],
    client,
    notifier,
    refreshPresence,
    stateStore: stateStore.store,
    validateChannels,
    createEventSub: eventSub.factory,
    setIntervalFn: interval.setIntervalFn,
    clearIntervalFn: interval.clearIntervalFn,
    ...overrides,
  };

  return {
    dependencies,
    logger,
    client,
    twitch,
    getLiveStreams,
    notify,
    stateStore,
    eventSub,
    interval,
    validateChannels,
    refreshPresence,
  };
}

describe("resolveChannelsWithRetry", () => {
  it("does not retry when the first attempt succeeds", async () => {
    const resolveChannels = vi.fn(async (_logins: string[]) => [channel]);
    const logger = { warn: vi.fn() };
    const sleep = vi.fn(async (_milliseconds: number) => {});

    await expect(
      resolveChannelsWithRetry({ resolveChannels }, ["one"], logger, { attempts: 3, baseDelayMs: 10, sleep }),
    ).resolves.toEqual([channel]);
    expect(resolveChannels).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries with exponential backoff until Twitch resolves the channels", async () => {
    const resolveChannels = vi.fn(async (_logins: string[]) => [channel]);
    resolveChannels
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockRejectedValueOnce(new Error("HTTP 503"));
    const logger = { warn: vi.fn() };
    const sleep = vi.fn(async (_milliseconds: number) => {});

    await expect(
      resolveChannelsWithRetry({ resolveChannels }, ["one"], logger, { attempts: 3, baseDelayMs: 100, sleep }),
    ).resolves.toEqual([channel]);
    expect(resolveChannels).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 200]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    const resolveChannels = vi.fn(async (_logins: string[]) => {
      throw new Error("Twitch is down");
    });
    const logger = { warn: vi.fn() };
    const sleep = vi.fn(async (_milliseconds: number) => {});

    await expect(
      resolveChannelsWithRetry({ resolveChannels }, ["one"], logger, { attempts: 2, baseDelayMs: 25, sleep }),
    ).rejects.toThrow("Twitch is down");
    expect(resolveChannels).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("createBot", () => {
  it("throws when none of the configured Twitch channels could be resolved", () => {
    const harness = createBotHarness({ channels: [] });
    expect(() => createBot(harness.dependencies)).toThrow(BotConfigurationError);
  });

  it("warns about unknown logins but starts with the resolved channels", () => {
    const harness = createBotHarness({
      guildConfig: {
        guilds: [{ guildId: "guild-1", alertChannelId: "channel-1", twitchChannels: ["one", "ghost"] }],
      },
    });
    expect(() => createBot(harness.dependencies)).not.toThrow();
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
  });

  it("validates channels, subscribes to EventSub and starts the reconcile loop on ready", async () => {
    const harness = createBotHarness();
    const bot = createBot(harness.dependencies);
    await bot.start();
    expect(harness.client.loginCalls).toEqual([config.discordToken]);

    harness.client.emitReady();
    await flushAsync();

    expect(harness.refreshPresence).toHaveBeenCalledTimes(1);
    expect(harness.validateChannels).toHaveBeenCalledWith(harness.client, guildConfig.guilds, harness.logger);
    expect(harness.eventSub.instances).toHaveLength(1);
    expect(harness.eventSub.instances[0]?.options.broadcasterIds).toEqual(["101"]);
    expect(harness.eventSub.instances[0]?.started).toBe(true);
    expect(harness.interval.callbacks).toHaveLength(1);
    expect(harness.interval.callbacks[0]?.milliseconds).toBe(config.reconcileIntervalSeconds * 1000);
    expect(harness.interval.callbacks[0]?.handle.unref).toHaveBeenCalled();
    expect(harness.logger.info).toHaveBeenCalledWith(expect.stringContaining("watching 1 Twitch channel"));
  });

  it("reconciles live streams once the EventSub session is ready", async () => {
    const harness = createBotHarness();
    harness.getLiveStreams.mockResolvedValue([liveStream]);
    const bot = createBot(harness.dependencies);
    await bot.start();
    harness.client.emitReady();
    await flushAsync();

    await harness.eventSub.instances[0]?.options.onSessionReady();

    expect(harness.getLiveStreams).toHaveBeenCalledWith(["101"]);
    expect(harness.notify).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "channel-1",
      stream: liveStream,
    });
    expect(harness.stateStore.save).toHaveBeenCalled();
  });

  it("uses the Helix stream details for stream.online events", async () => {
    const harness = createBotHarness();
    harness.getLiveStreams.mockResolvedValue([liveStream]);
    const bot = createBot(harness.dependencies);
    await bot.start();
    harness.client.emitReady();
    await flushAsync();

    await harness.eventSub.instances[0]?.options.onStreamOnline(onlineEvent);

    expect(harness.notify).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "channel-1",
      stream: liveStream,
    });
  });

  it("falls back to a minimal alert when the Helix lookup fails", async () => {
    const harness = createBotHarness();
    harness.getLiveStreams.mockRejectedValueOnce(new Error("network down"));
    const bot = createBot(harness.dependencies);
    await bot.start();
    harness.client.emitReady();
    await flushAsync();

    await harness.eventSub.instances[0]?.options.onStreamOnline(onlineEvent);

    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
    expect(harness.notify).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "channel-1",
      stream: expect.objectContaining({
        id: "stream-1",
        broadcasterId: "101",
        broadcasterLogin: "one",
        title: "",
        categoryName: "",
        url: "https://www.twitch.tv/one",
        isLive: true,
      }),
    });
  });

  it("ignores stream.online events for broadcasters that are not configured", async () => {
    const harness = createBotHarness();
    const bot = createBot(harness.dependencies);
    await bot.start();
    harness.client.emitReady();
    await flushAsync();

    await harness.eventSub.instances[0]?.options.onStreamOnline({
      ...onlineEvent,
      broadcaster_user_id: "999",
      broadcaster_user_login: "other",
    });

    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining("not configured"));
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("runs the reconciliation on every timer tick and refreshes the presence", async () => {
    const harness = createBotHarness();
    harness.getLiveStreams.mockResolvedValue([liveStream]);
    const bot = createBot(harness.dependencies);
    await bot.start();
    harness.client.emitReady();
    await flushAsync();

    harness.interval.callbacks[0]?.callback();
    await flushAsync();

    expect(harness.getLiveStreams).toHaveBeenCalledWith(["101"]);
    expect(harness.refreshPresence).toHaveBeenCalledTimes(2);
  });

  it("stops EventSub, clears the interval and destroys the client on shutdown", async () => {
    const harness = createBotHarness();
    const bot = createBot(harness.dependencies);
    await bot.start();
    harness.client.emitReady();
    await flushAsync();

    const handle = harness.interval.callbacks[0]?.handle;
    await bot.shutdown("SIGTERM");
    await bot.shutdown("SIGTERM");

    expect(harness.interval.clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(harness.interval.clearIntervalFn).toHaveBeenCalledWith(handle);
    expect(harness.eventSub.instances[0]?.stopped).toBe(true);
    expect(harness.client.destroyed).toBe(true);
  });

  it("reports Discord login failures and destroys the client", async () => {
    const harness = createBotHarness();
    harness.client.loginError = new Error("invalid token");
    const bot = createBot(harness.dependencies);

    await bot.start();

    expect(harness.logger.error).toHaveBeenCalledWith(expect.stringContaining("invalid token"));
    expect(process.exitCode).toBe(1);
    expect(harness.client.destroyed).toBe(true);
  });

  it("logs Discord client errors and warnings", async () => {
    const harness = createBotHarness();
    const bot = createBot(harness.dependencies);
    await bot.start();

    harness.client.onHandlers.get("error")?.(new Error("socket closed"));
    harness.client.onHandlers.get("warn")?.("shard lagging");

    expect(harness.logger.error).toHaveBeenCalledWith(expect.stringContaining("socket closed"));
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining("shard lagging"));
  });
});

function createMainHarness(overrides: Partial<MainDependencies> = {}) {
  const logger = createLoggerSpy();
  const client = new FakeClient();
  const resolveChannels = vi.fn(async (_logins: string[]) => [channel]);
  const getLiveStreams = vi.fn(async (_broadcasterIds: string[]) => [] as LiveStream[]);
  const twitch: TwitchStreamsPort = {
    resolveChannels,
    subscribeToOnline: vi.fn(async () => {}),
    getLiveStreams,
  };
  const notify = vi.fn(async (_input: { guildId: string; channelId: string; stream: LiveStream }) => ({ messageId: "message-1" }));
  const notifier: StreamNotifierPort = { notify, markStreamEnded: vi.fn(async () => {}) };
  const stateStore = createFakeStateStore();
  const eventSub = createEventSubCapture();
  const validateChannels = vi.fn(async () => {});
  const refreshPresence = vi.fn();
  const registerSignal = vi.fn((_signal: "SIGINT" | "SIGTERM", _handler: () => void) => {});
  const sleep = vi.fn(async (_milliseconds: number) => {});

  const dependencies: MainDependencies = {
    ...defaultMainDependencies,
    loadConfig: () => config,
    loadGuildConfig: async () => guildConfig,
    createLogger: () => logger,
    createTwitch: () => twitch,
    createClient: () => client,
    createNotifier: () => notifier,
    attachPresence: () => refreshPresence,
    createStateStore: () => stateStore.store,
    validateChannels,
    createEventSub: eventSub.factory,
    registerSignal,
    sleep,
    resolveAttempts: 1,
    resolveBaseDelayMs: 10,
    ...overrides,
  };

  return {
    dependencies,
    logger,
    client,
    twitch,
    resolveChannels,
    getLiveStreams,
    notify,
    stateStore,
    eventSub,
    validateChannels,
    refreshPresence,
    registerSignal,
    sleep,
  };
}

describe("main", () => {
  it("reports invalid environment configuration and marks a failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const createLogger = vi.fn(() => createLoggerSpy());

    await main({
      loadConfig: () => {
        throw new ConfigError("Missing required environment variable DISCORD_TOKEN");
      },
      createLogger,
    });

    expect(consoleError).toHaveBeenCalledWith("Missing required environment variable DISCORD_TOKEN");
    expect(createLogger).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("reports a broken guild configuration and does not log in", async () => {
    const harness = createMainHarness({
      loadGuildConfig: async () => {
        throw new Error("guilds.json is not valid JSON");
      },
    });

    await main(harness.dependencies);

    expect(harness.logger.error).toHaveBeenCalledWith("guilds.json is not valid JSON");
    expect(process.exitCode).toBe(1);
    expect(harness.client.loginCalls).toEqual([]);
  });

  it("rejects an empty guild configuration", async () => {
    const harness = createMainHarness({ loadGuildConfig: async () => ({ guilds: [] }) });

    await main(harness.dependencies);

    expect(harness.logger.error).toHaveBeenCalledWith("Guild configuration has no guild entries");
    expect(process.exitCode).toBe(1);
    expect(harness.client.loginCalls).toEqual([]);
  });

  it("retries Twitch channel resolution and aborts when Twitch stays down", async () => {
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const harness = createMainHarness({ resolveAttempts: 3, resolveBaseDelayMs: 10, sleep });
    harness.resolveChannels.mockRejectedValue(new Error("fetch failed"));

    await main(harness.dependencies);

    expect(harness.resolveChannels).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([10, 20]);
    expect(harness.logger.error).toHaveBeenCalledWith(expect.stringContaining("Could not resolve configured Twitch channels"));
    expect(process.exitCode).toBe(1);
    expect(harness.client.loginCalls).toEqual([]);
  });

  it("refuses to start when every configured login is unresolved", async () => {
    const harness = createMainHarness({
      loadGuildConfig: async () => ({
        guilds: [{ guildId: "guild-1", alertChannelId: "channel-1", twitchChannels: ["ghost"] }],
      }),
    });
    harness.resolveChannels.mockResolvedValue([]);

    await main(harness.dependencies);

    expect(harness.logger.error).toHaveBeenCalledWith(expect.stringContaining("None of the configured Twitch channels could be resolved"));
    expect(process.exitCode).toBe(1);
    expect(harness.client.loginCalls).toEqual([]);
  });

  it("warns about unknown logins and starts the bot with the resolved ones", async () => {
    const harness = createMainHarness({
      loadGuildConfig: async () => ({
        guilds: [{ guildId: "guild-1", alertChannelId: "channel-1", twitchChannels: ["one", "ghost"] }],
      }),
    });

    await main(harness.dependencies);

    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    expect(harness.client.loginCalls).toEqual([config.discordToken]);

    harness.client.emitReady();
    await flushAsync();

    expect(harness.validateChannels).toHaveBeenCalled();
    expect(harness.eventSub.instances[0]?.options.broadcasterIds).toEqual(["101"]);
  });

  it("registers shutdown signals and logs in with the configured Discord token", async () => {
    const harness = createMainHarness();

    await main(harness.dependencies);

    expect(harness.registerSignal.mock.calls.map(([signal]) => signal)).toEqual(["SIGINT", "SIGTERM"]);
    expect(harness.client.loginCalls).toEqual([config.discordToken]);

    const shutdownHandler = harness.registerSignal.mock.calls[0]?.[1] as (() => void) | undefined;
    shutdownHandler?.();
    await flushAsync();

    expect(harness.client.destroyed).toBe(true);
  });
});
