import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonLiveStateStore } from "../src/infrastructure/persistence/json-live-state-store.js";
import type { LiveStreamState } from "../src/domain/ports/live-state-store.js";

const directories: string[] = [];
async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "live-state-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function logger() {
  return { warn: vi.fn() };
}

describe("createJsonLiveStateStore", () => {
  it("returns empty state when there is no saved file", async () => {
    const path = join(await makeTempDir(), "data", "live.json");
    expect(await createJsonLiveStateStore(path).load()).toEqual({});
  });

  it("atomically saves readable JSON with private permissions", async () => {
    const path = join(await makeTempDir(), "data", "live.json");
    const store = createJsonLiveStateStore(path);
    const state: LiveStreamState = {
      "broadcaster-1": {
        streamId: "stream-1",
        deliveredTo: ["guild-a:alerts-a"],
        alerts: [{ guildId: "guild-a", channelId: "alerts-a", messageId: "message-1" }],
      },
    };
    await store.save(state);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
    expect(await store.load()).toEqual(state);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("migrates legacy string state without re-alerting on restart", async () => {
    const path = join(await makeTempDir(), "legacy.json");
    await writeFile(path, JSON.stringify({ "broadcaster-1": "stream-1" }));
    expect(await createJsonLiveStateStore(path).load()).toEqual({
      "broadcaster-1": { streamId: "stream-1", deliveredTo: ["*"], alerts: [] },
    });
  });

  it("moves malformed JSON aside and starts with empty state", async () => {
    const directory = await makeTempDir();
    const path = join(directory, "bad.json");
    await writeFile(path, "{");
    const log = logger();
    expect(await createJsonLiveStateStore(path, log).load()).toEqual({});
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("moved to"));
    expect((await readdir(directory)).some((name) => name.startsWith("bad.json.corrupt-"))).toBe(true);
  });

  it("moves an invalid state schema aside instead of disabling alerts", async () => {
    const directory = await makeTempDir();
    const path = join(directory, "bad.json");
    await writeFile(path, JSON.stringify(["unexpected"]));
    const log = logger();
    expect(await createJsonLiveStateStore(path, log).load()).toEqual({});
    expect(log.warn).toHaveBeenCalledOnce();
    expect((await readdir(directory)).some((name) => name.startsWith("bad.json.corrupt-"))).toBe(true);
  });

  it("moves invalid alert references aside instead of disabling alerts", async () => {
    const directory = await makeTempDir();
    const path = join(directory, "bad-alerts.json");
    await writeFile(path, JSON.stringify({
      "broadcaster-1": {
        streamId: "stream-1",
        deliveredTo: ["guild-a:alerts-a"],
        alerts: [{ guildId: "guild-a", channelId: "alerts-a" }],
      },
    }));
    const log = logger();
    expect(await createJsonLiveStateStore(path, log).load()).toEqual({});
    expect(log.warn).toHaveBeenCalledOnce();
    expect((await readdir(directory)).some((name) => name.startsWith("bad-alerts.json.corrupt-"))).toBe(true);
  });
});
