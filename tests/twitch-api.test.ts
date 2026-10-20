import { afterEach, describe, expect, it, vi } from "vitest";
import { TwitchApi } from "../src/infrastructure/twitch/twitch-api.js";
import type { AppConfig } from "../src/infrastructure/config/env.js";
import * as tokenStore from "../src/infrastructure/twitch/token-store.js";

const config: AppConfig = {
  discordToken: "discord",
  twitchClientId: "client-id",
  twitchClientSecret: "client-secret",
  twitchUserAccessToken: "access-old",
  twitchRefreshToken: "refresh-old",
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
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("TwitchApi", () => {
  it("resolves multiple Twitch logins in one Helix request", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => jsonResponse({ data: [
      { id: "101", login: "one", display_name: "One", profile_image_url: "https://images.example/one.png" },
      { id: "102", login: "two", display_name: "Two", profile_image_url: "https://images.example/two.png" },
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new TwitchApi(config);
    expect(await api.resolveChannels(["One", "two", "ONE"])).toEqual([
      { id: "101", login: "one", displayName: "One", profileImageUrl: "https://images.example/one.png", url: "https://www.twitch.tv/one" },
      { id: "102", login: "two", displayName: "Two", profileImageUrl: "https://images.example/two.png", url: "https://www.twitch.tv/two" },
    ]);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/helix/users");
    expect(url.searchParams.getAll("login")).toEqual(["one", "two"]);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(firstInit?.headers).toMatchObject({ Authorization: "Bearer access-old", "Client-Id": "client-id" });
  });

  it("returns only resolved channels instead of failing on unknown logins", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [
      { id: "101", login: "one", display_name: "One", profile_image_url: "https://images.example/one.png" },
    ] })));
    await expect(new TwitchApi(config).resolveChannels(["one", "renamed_away"])).resolves.toEqual([
      { id: "101", login: "one", displayName: "One", profileImageUrl: "https://images.example/one.png", url: "https://www.twitch.tv/one" },
    ]);
  });

  it("creates stream.online EventSub subscriptions against the WebSocket session", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => jsonResponse({ data: [] }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await new TwitchApi(config).subscribeToOnline("broadcaster-1", "session-1");
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://api.twitch.tv/helix/eventsub/subscriptions");
    expect(call?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        type: "stream.online", version: "1", condition: { broadcaster_user_id: "broadcaster-1" },
        transport: { method: "websocket", session_id: "session-1" },
      }),
    }));
  });

  it("treats a duplicate EventSub subscription as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 409 })));
    await expect(new TwitchApi(config).subscribeToOnline("broadcaster-1", "session-1")).resolves.toBeUndefined();
  });

  it("queries streams by broadcaster IDs and maps response to domain streams", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/helix/users") return jsonResponse({ data: [
        { id: "101", login: "One", display_name: "OneName", profile_image_url: "https://images.example/one.png" },
      ] });
      return jsonResponse({ data: [{
        id: "stream-1", user_id: "101", user_login: "One", user_name: "OneName", title: "Title", game_name: "Game", started_at: "2025-01-02T03:04:05Z",
        thumbnail_url: "https://images.example/stream-{width}x{height}.jpg", viewer_count: 123,
      }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new TwitchApi(config);
    await api.resolveChannels(["one"]);
    const streams = await api.getLiveStreams(["101"]);
    expect(streams[0]).toEqual({
      id: "stream-1", broadcasterId: "101", broadcasterLogin: "one", broadcasterName: "OneName", title: "Title",
      categoryName: "Game", startedAt: "2025-01-02T03:04:05Z", url: "https://www.twitch.tv/One",
      thumbnailUrl: "https://images.example/stream-1280x720.jpg?v=stream-1", viewerCount: 123,
      profileImageUrl: "https://images.example/one.png", isLive: true,
    });
    const streamsRequest = fetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname === "/helix/streams");
    expect(new URL(String(streamsRequest?.[0])).searchParams.getAll("user_id")).toEqual(["101"]);
  });

  it("refreshes an expiring access token before issuing the API request", async () => {
    const fetchMock = vi.fn((_input: URL | RequestInfo, _init?: RequestInit) => Promise.resolve(jsonResponse({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 })));
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const saveSpy = vi.spyOn(tokenStore, "saveTwitchTokens").mockResolvedValue();
    const api = new TwitchApi({ ...config, twitchUserTokenExpiresAt: Date.now() + 1_000 });
    await api.getLiveStreams(["101"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenCalledWith(config.envPath, expect.objectContaining({ accessToken: "access-new", refreshToken: "refresh-new", expiresAt: expect.any(Number) }));
  });

  it("refreshes and persists rotated OAuth tokens after a 401", async () => {
    const fetchMock = vi.fn((_input: URL | RequestInfo, _init?: RequestInit) => Promise.resolve(jsonResponse({ error: "Unauthorized" }, 401)))
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-new", refresh_token: "refresh-new" }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const saveSpy = vi.spyOn(tokenStore, "saveTwitchTokens").mockResolvedValue();
    const api = new TwitchApi(config);
    await api.getLiveStreams(["101"]);
    expect(api.currentAccessToken).toBe("access-new");
    expect(saveSpy).toHaveBeenCalledWith(config.envPath, { accessToken: "access-new", refreshToken: "refresh-new" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryInit = fetchMock.mock.calls[2]?.[1] as RequestInit | undefined;
    expect(retryInit?.headers).toMatchObject({ Authorization: "Bearer access-new" });
  });

  it("does not expose API response bodies in errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-token-leak", { status: 500 })));
    await expect(new TwitchApi(config, { maxRetries: 0 }).getLiveStreams(["101"])).rejects.toThrow(/HTTP 500/);
    await expect(new TwitchApi(config, { maxRetries: 0 }).getLiveStreams(["101"])).rejects.not.toThrow(/private-token-leak/);
  });

  it("retries transient 5xx responses before failing", async () => {
    const fetchMock = vi.fn((_input: URL | RequestInfo, _init?: RequestInit) => Promise.resolve(new Response("", { status: 500 })))
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new TwitchApi(config, { maxRetries: 2, retryDelayMs: 1 });
    await expect(api.getLiveStreams(["101"])).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After when Twitch answers 429", async () => {
    const fetchMock = vi.fn((_input: URL | RequestInfo, _init?: RequestInit) => Promise.resolve(jsonResponse({ data: [] })))
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new TwitchApi(config, { maxRetries: 1, retryDelayMs: 60_000 });
    await expect(api.getLiveStreams(["101"])).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries network failures and surfaces the last error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new TwitchApi(config, { maxRetries: 1, retryDelayMs: 1 });
    await expect(api.getLiveStreams(["101"])).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
