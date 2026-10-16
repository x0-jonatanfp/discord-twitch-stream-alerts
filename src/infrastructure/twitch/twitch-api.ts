import type { AppConfig } from "../config/env.js";
import type { ChannelProfile, LiveStream, TwitchChannel } from "../../domain/entities/stream.js";
import type { TwitchStreamsPort } from "../../domain/ports/twitch-streams.js";
import { saveTwitchTokens } from "./token-store.js";

interface TwitchUserResponse {
  data: Array<{ id: string; login: string; display_name: string; profile_image_url: string }>;
}

interface TwitchStreamsResponse {
  data: Array<{
    id: string;
    user_id: string;
    user_login: string;
    user_name: string;
    title: string;
    game_name: string;
    started_at: string;
    thumbnail_url: string;
    viewer_count: number;
  }>;
}

interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export class TwitchApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TwitchApiError";
  }
}

export class TwitchApi implements TwitchStreamsPort {
  private accessToken: string;
  private refreshToken: string;
  private refreshPromise: Promise<void> | null = null;
  private tokenExpiresAt: number | null;
  private readonly profileImageById = new Map<string, string>();

  constructor(private readonly config: AppConfig) {
    this.accessToken = config.twitchUserAccessToken;
    this.refreshToken = config.twitchRefreshToken;
    this.tokenExpiresAt = config.twitchUserTokenExpiresAt;
  }

  get currentAccessToken(): string {
    return this.accessToken;
  }

  async resolveChannels(logins: string[]): Promise<TwitchChannel[]> {
    const uniqueLogins = [...new Set(logins.map((login) => login.toLowerCase()))];
    const results: TwitchChannel[] = [];
    for (let index = 0; index < uniqueLogins.length; index += 100) {
      const batch = uniqueLogins.slice(index, index + 100);
      const url = new URL("https://api.twitch.tv/helix/users");
      for (const login of batch) url.searchParams.append("login", login);
      const response = await this.request<TwitchUserResponse>(url);
      results.push(...response.data.map((user) => {
        this.profileImageById.set(user.id, user.profile_image_url);
        return {
          id: user.id,
          login: user.login.toLowerCase(),
          displayName: user.display_name,
          profileImageUrl: user.profile_image_url,
          url: `https://www.twitch.tv/${encodeURIComponent(user.login)}`,
        };
      }));
    }
    const resolvedLogins = new Set(results.map((channel) => channel.login));
    const unknownLogins = uniqueLogins.filter((login) => !resolvedLogins.has(login));
    if (unknownLogins.length > 0) {
      throw new Error(`Unknown Twitch channel login(s): ${unknownLogins.join(", ")}`);
    }
    return results;
  }

  async getChannelProfile(broadcasterId: string): Promise<ChannelProfile> {
    const url = new URL("https://api.twitch.tv/helix/users");
    url.searchParams.set("id", broadcasterId);
    const { data } = await this.request<TwitchUserResponse>(url);
    const user = data[0];
    if (!user) throw new Error(`Unknown Twitch broadcaster ID ${broadcasterId}`);
    this.profileImageById.set(user.id, user.profile_image_url);
    return {
      id: user.id,
      login: user.login.toLowerCase(),
      displayName: user.display_name,
      profileImageUrl: user.profile_image_url,
      url: `https://www.twitch.tv/${encodeURIComponent(user.login)}`,
      isLive: false,
    };
  }

  async subscribeToOnline(broadcasterId: string, sessionId: string): Promise<void> {
    await this.request<unknown>("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stream.online",
        version: "1",
        condition: { broadcaster_user_id: broadcasterId },
        transport: { method: "websocket", session_id: sessionId },
      }),
    });
  }

  async getLiveStreams(broadcasterIds: string[]): Promise<LiveStream[]> {
    const uniqueIds = [...new Set(broadcasterIds)];
    const results: LiveStream[] = [];
    for (let index = 0; index < uniqueIds.length; index += 100) {
      const batch = uniqueIds.slice(index, index + 100);
      if (batch.length === 0) continue;
      const url = new URL("https://api.twitch.tv/helix/streams");
      for (const id of batch) url.searchParams.append("user_id", id);
      url.searchParams.set("first", String(batch.length));
      const response = await this.request<TwitchStreamsResponse>(url);
      results.push(...response.data.map((stream) => ({
        id: stream.id,
        broadcasterId: stream.user_id,
        broadcasterLogin: stream.user_login.toLowerCase(),
        broadcasterName: stream.user_name,
        title: stream.title,
        categoryName: stream.game_name,
        startedAt: stream.started_at,
        url: `https://www.twitch.tv/${encodeURIComponent(stream.user_login)}`,
        thumbnailUrl: stream.thumbnail_url.replace("{width}", "1280").replace("{height}", "720"),
        viewerCount: stream.viewer_count,
        profileImageUrl: this.profileImageById.get(stream.user_id) ?? "",
        isLive: true as const,
      })));
    }
    return results;
  }

  private async request<T>(input: URL | string, init: RequestInit = {}): Promise<T> {
    if (this.tokenExpiresAt !== null && this.tokenExpiresAt - Date.now() < 60_000) {
      await this.refreshAccessToken();
    }
    const execute = async (): Promise<Response> => fetch(input, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${this.accessToken}`,
        "Client-Id": this.config.twitchClientId,
      },
      signal: AbortSignal.timeout(15_000),
    });
    let response = await execute();
    if (response.status === 401) {
      await this.refreshAccessToken();
      response = await execute();
    }
    if (!response.ok) {
      throw new TwitchApiError(`Twitch API request failed with HTTP ${response.status}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private async refreshAccessToken(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async performRefresh(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.config.twitchClientId,
      client_secret: this.config.twitchClientSecret,
    });
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new TwitchApiError(`Twitch OAuth refresh failed with HTTP ${response.status}`, response.status);
    const token: unknown = await response.json();
    if (typeof token !== "object" || token === null || typeof (token as OAuthTokens).access_token !== "string") {
      throw new Error("Twitch OAuth refresh returned an invalid response");
    }
    const tokens = token as OAuthTokens;
    const nextRefreshToken = tokens.refresh_token ?? this.refreshToken;
    const expiresAt = typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
    await saveTwitchTokens(this.config.envPath, {
      accessToken: tokens.access_token,
      refreshToken: nextRefreshToken,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    this.accessToken = tokens.access_token;
    this.refreshToken = nextRefreshToken;
    this.tokenExpiresAt = expiresAt ?? null;
  }
}
