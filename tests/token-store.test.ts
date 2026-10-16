import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveTwitchTokens } from "../src/infrastructure/twitch/token-store.js";

const directories: string[] = [];
async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stream-alerts-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("saveTwitchTokens", () => {
  it("updates only Twitch token lines and preserves other local settings", async () => {
    const envPath = join(await makeTempDir(), ".env");
    await writeFile(envPath, "DISCORD_TOKEN=discord-secret\nTWITCH_CLIENT_ID=client\nTWITCH_CLIENT_SECRET=secret\nTWITCH_USER_ACCESS_TOKEN=old\nTWITCH_REFRESH_TOKEN=old-refresh\nBOT_ACTIVITY_NAME=promo\n", { mode: 0o600 });
    await saveTwitchTokens(envPath, { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 1_735_789_200_000 });
    const content = await readFile(envPath, "utf8");
    expect(content).toContain("DISCORD_TOKEN=discord-secret");
    expect(content).toContain("TWITCH_CLIENT_ID=client");
    expect(content).toContain("TWITCH_USER_ACCESS_TOKEN=new-access");
    expect(content).toContain("TWITCH_REFRESH_TOKEN=new-refresh");
    expect(content).toContain("TWITCH_USER_TOKEN_EXPIRES_AT=1735789200000");
    expect(content).toContain("BOT_ACTIVITY_NAME=promo");
    expect(content.match(/^TWITCH_USER_ACCESS_TOKEN=/gm)).toHaveLength(1);
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("creates a new private env file if it does not exist", async () => {
    const envPath = join(await makeTempDir(), ".env");
    await saveTwitchTokens(envPath, { accessToken: "access", refreshToken: "refresh" });
    expect(await readFile(envPath, "utf8")).toBe("TWITCH_USER_ACCESS_TOKEN=access\nTWITCH_REFRESH_TOKEN=refresh\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  });

  it("appends tokens to existing env while keeping last newline formatting", async () => {
    const envPath = join(await makeTempDir(), ".env");
    await writeFile(envPath, "DISCORD_TOKEN=keep\n");
    await saveTwitchTokens(envPath, { accessToken: "a", refreshToken: "r" });
    expect(await readFile(envPath, "utf8")).toBe("DISCORD_TOKEN=keep\nTWITCH_USER_ACCESS_TOKEN=a\nTWITCH_REFRESH_TOKEN=r\n");
  });
});
