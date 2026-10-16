import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { LiveStateStorePort, LiveStreamState } from "../../domain/ports/live-state-store.js";

export function createJsonLiveStateStore(path: string): LiveStateStorePort {
  return {
    async load() {
      try {
        const data: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isLiveState(data)) throw new Error(`Invalid live stream state file ${path}`);
        return data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryPath, path);
      } catch (error) {
        await import("node:fs/promises").then(({ unlink }) => unlink(temporaryPath)).catch(() => undefined);
        throw error;
      }
    },
  };
}

function isLiveState(value: unknown): value is LiveStreamState {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.entries(value).every(([id, streamId]) => id.length > 0 && typeof streamId === "string");
}
