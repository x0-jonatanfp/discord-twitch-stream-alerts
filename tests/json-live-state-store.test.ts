import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonLiveStateStore } from "../src/infrastructure/persistence/json-live-state-store.js";

const directories: string[] = [];
async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "live-state-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createJsonLiveStateStore", () => {
  it("returns empty state when there is no saved file", async () => {
    const path = join(await makeTempDir(), "data", "live.json");
    expect(await createJsonLiveStateStore(path).load()).toEqual({});
  });

  it("atomically saves readable JSON with private permissions", async () => {
    const path = join(await makeTempDir(), "data", "live.json");
    const store = createJsonLiveStateStore(path);
    const state = { "broadcaster-1": "stream-1" };
    await store.save(state);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
    expect(await store.load()).toEqual(state);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed JSON rather than treating it as empty", async () => {
    const path = join(await makeTempDir(), "bad.json");
    await writeFile(path, "{");
    await expect(createJsonLiveStateStore(path).load()).rejects.toThrow(SyntaxError);
  });

  it("rejects an invalid state schema", async () => {
    const path = join(await makeTempDir(), "bad.json");
    await writeFile(path, JSON.stringify(["unexpected"]));
    await expect(createJsonLiveStateStore(path).load()).rejects.toThrow(/Invalid live stream state/);
  });
});
