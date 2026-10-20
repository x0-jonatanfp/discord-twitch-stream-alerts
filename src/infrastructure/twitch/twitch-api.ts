import type { AppConfig } from "../config/env.js";
import type { LiveStream, TwitchChannel } from "../../domain/entities/stream.js";
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

export interface TwitchApiOptions {
  /** Extra attempts after the first one for transient failures (default 2). */
  maxRetries?: number;
  /** Base delay for the exponential backoff in milliseconds (default 1000). */
  retryDelayMs?: number;
}

export class TwitchApi implements TwitchStreamsPort {
  private accessToken: string;
  private refreshToken: string;
  private refreshPromise: Promise<void> | null = null;
  private tokenExpiresAt: number | null;
  private readonly profileImageById = new Map<string, string>();
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly config: AppConfig, options: TwitchApiOptions = {}) {
    this.accessToken = config.twitchUserAccessToken;
    this.refreshToken = config.twitchRefreshToken;
    this.tokenExpiresAt = config.twitchUserTokenExpiresAt;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
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
    // Unknown logins are returned to the caller instead of aborting all
    // monitoring. A renamed or deleted channel must not disable other channels.
    return results;
  }

  async subscribeToOnline(broadcasterId: string, sessionId: string): Promise<void> {
    try {
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
    } catch (error) {
      // Twitch may still consider the subscription active during a fast
      // reconnect. Treat the duplicate as success.
      if (error instanceof TwitchApiError && error.status === 409) return;
      throw error;
    }
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
        thumbnailUrl: withCacheBuster(
          stream.thumbnail_url.replace("{width}", "1280").replace("{height}", "720"),
          stream.id,
        ),
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

    let refreshedAfterUnauthorized = false;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await execute();
      } catch (error) {
        // A network failure or timeout is transient: retry before giving up.
        if (attempt >= this.maxRetries) throw error;
        await this.sleepForRetry(attempt, null);
        continue;
      }
      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        await this.refreshAccessToken();
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        await this.sleepForRetry(attempt, response.headers.get("retry-after"));
        continue;
      }
      if (!response.ok) {
        throw new TwitchApiError(`Twitch API request failed with HTTP ${response.status}`, response.status);
      }
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    }
  }

  private async sleepForRetry(attempt: number, retryAfter: string | null): Promise<void> {
    const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1_000
      : this.retryDelayMs * 2 ** attempt;
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(Math.max(delay, 0), 30_000));
    });
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

/**
 * Twitch's live preview URL is the same for every broadcast of a channel, so
 * Discord serves its cached copy from a previous stream. The per-stream query
 * parameter gives Discord a distinct URL without changing the CDN response.
 */
function withCacheBuster(url: string, streamId: string): string {
  const preview = new URL(url);
  preview.searchParams.set("v", streamId);
  return preview.toString();
}
