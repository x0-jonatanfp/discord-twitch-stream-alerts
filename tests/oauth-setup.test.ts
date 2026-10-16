import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTwitchOAuthSetup } from "../src/infrastructure/twitch/oauth-setup.js";

const originalEnv = process.env;
const dirs: string[] = [];
afterEach(async () => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createOAuthEnv(port: number): Promise<{ dir: string; envPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "oauth-setup-test-"));
  dirs.push(dir);
  const envPath = join(dir, ".env");
  await writeFile(envPath, [
    "TWITCH_CLIENT_ID=test-client-id",
    "TWITCH_CLIENT_SECRET=test-client-secret",
    `TWITCH_REDIRECT_URI=http://localhost:${port}/callback`,
    "DISCORD_TOKEN=",
    "TWITCH_USER_ACCESS_TOKEN=",
    "TWITCH_REFRESH_TOKEN=",
  ].join("\n"));
  return { dir, envPath };
}

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port assigned");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe("runTwitchOAuthSetup", () => {
  it("validates state, exchanges code, saves tokens privately, and never logs token values", async () => {
    const port = await getFreePort();
    const { envPath } = await createOAuthEnv(port);
    process.env = { ...originalEnv, ENV_FILE: envPath };
    const logLines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { logLines.push(args.join(" ")); });
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).startsWith("https://id.twitch.tv/")) {
        const body = String(init?.body ?? "");
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=auth-code");
        return new Response(JSON.stringify({ access_token: "private-access-token", refresh_token: "private-refresh-token", expires_in: 3600, token_type: "bearer", scope: [] }), { status: 200 });
      }
      return nativeFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const setup = runTwitchOAuthSetup();
    await vi.waitFor(() => expect(logLines.some((line) => line.includes("http://localhost"))).toBe(true));
    const authorizationLine = logLines.find((line) => line.startsWith("https://id.twitch.tv/oauth2/authorize"));
    expect(authorizationLine).toBeDefined();
    const authorizationUrl = new URL(authorizationLine!);
    expect(authorizationUrl.searchParams.get("scope")).toBeNull();
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toMatch(/^[a-f0-9]{64}$/);

    const invalidStateResponse = await fetch(`http://127.0.0.1:${port}/callback?code=wrong&state=incorrect`);
    expect(invalidStateResponse.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("id.twitch.tv"), expect.anything());

    const callbackResponse = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=${state}`);
    expect(callbackResponse.status).toBe(200);
    await setup;

    const content = await readFile(envPath, "utf8");
    expect(content).toContain("TWITCH_USER_ACCESS_TOKEN=private-access-token");
    expect(content).toContain("TWITCH_REFRESH_TOKEN=private-refresh-token");
    expect(content).toContain("TWITCH_USER_TOKEN_EXPIRES_AT=");
    expect(logLines.join("\n")).not.toContain("private-access-token");
    expect(logLines.join("\n")).not.toContain("private-refresh-token");
  });
});
