import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAppConfig } from "../config/env.js";
import { saveTwitchTokens } from "./token-store.js";

interface TwitchTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string[];
}

export async function runTwitchOAuthSetup(): Promise<void> {
  const envPath = resolve(process.env.ENV_FILE ?? ".env");
  let config;
  try {
    config = loadAppConfig(envPath, { requireDiscordToken: false, requireUserTokens: false, validateActivityUrl: false });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid environment configuration");
    process.exitCode = 1;
    return;
  }

  const redirectUri = new URL(config.twitchRedirectUri);
  const port = Number(redirectUri.port);
  const state = randomBytes(32).toString("hex");
  const authorizationUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authorizationUrl.searchParams.set("client_id", config.twitchClientId);
  authorizationUrl.searchParams.set("redirect_uri", config.twitchRedirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("force_verify", "true");

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", config.twitchRedirectUri);
    if (requestUrl.pathname !== redirectUri.pathname) {
      response.writeHead(404).end("Not found");
      return;
    }
    const returnedState = requestUrl.searchParams.get("state");
    if (!returnedState || !constantTimeEquals(state, returnedState)) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("OAuth state validation failed. You can close this tab.");
      return;
    }
    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Twitch authorization was not granted. You can close this tab.");
      server.close();
      console.error(`Twitch authorization was not granted (${oauthError}).`);
      process.exitCode = 1;
      return;
    }
    const code = requestUrl.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Missing OAuth authorization code. You can close this tab.");
      return;
    }

    try {
      const token = await exchangeAuthorizationCode({
        clientId: config.twitchClientId,
        clientSecret: config.twitchClientSecret,
        redirectUri: config.twitchRedirectUri,
        code,
      });
      await saveTwitchTokens(envPath, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        "<!doctype html><html><body><h1>Twitch connected</h1><p>Tokens were saved securely. You can close this tab.</p></body></html>",
      );
      console.info(`Twitch user authorization saved to ${envPath}. Token values were not displayed.`);
      server.close();
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Could not save Twitch authorization. Check the local terminal for a generic error.");
      console.error(error instanceof Error ? error.message : "Twitch OAuth failed");
      process.exitCode = 1;
      server.close();
    }
  });

  const timeout = setTimeout(() => {
    server.close();
    console.error("Twitch authorization timed out after 3 minutes.");
    process.exitCode = 1;
  }, 180_000);
  timeout.unref();
  server.once("close", () => clearTimeout(timeout));

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });

  console.info("Open this URL in your browser and authorize the app:");
  console.info(authorizationUrl.toString());
  console.info(`Waiting for Twitch callback on ${config.twitchRedirectUri} (no token values will be printed).`);
}

async function exchangeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<TwitchTokenResponse> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const result: unknown = await response.json();
  if (!response.ok || !isTokenResponse(result)) {
    throw new Error(`Twitch token exchange failed with HTTP ${response.status}`);
  }
  return result;
}

function isTokenResponse(value: unknown): value is TwitchTokenResponse {
  if (typeof value !== "object" || value === null) return false;
  const token = value as Record<string, unknown>;
  return typeof token.access_token === "string" && typeof token.refresh_token === "string";
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTwitchOAuthSetup().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Twitch OAuth setup failed");
    process.exitCode = 1;
  });
}
