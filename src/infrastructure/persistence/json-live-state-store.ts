import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { LoggerPort } from "../../domain/ports/logger.js";
import type { StreamAlertMessage } from "../../domain/entities/stream.js";
import type {
  LiveStateStorePort,
  LiveStreamState,
  LiveStreamStateEntry,
} from "../../domain/ports/live-state-store.js";

type StateLogger = Pick<LoggerPort, "warn">;

export function createJsonLiveStateStore(
  path: string,
  logger?: StateLogger,
): LiveStateStorePort {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }

      try {
        return parseLiveState(JSON.parse(raw));
      } catch (error) {
        // A corrupt state file must not disable every future alert. Preserve it
        // for inspection and continue with an empty state.
        const backupPath = `${path}.corrupt-${Date.now()}`;
        try {
          await rename(path, backupPath);
        } catch {
          throw error;
        }
        logger?.warn(
          `Live stream state file ${path} was invalid and was moved to ${backupPath}; starting with empty state`,
        );
        return {};
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

function parseLiveState(value: unknown): LiveStreamState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid live stream state");
  }

  const state: LiveStreamState = {};
  for (const [broadcasterId, rawEntry] of Object.entries(value)) {
    if (!broadcasterId) throw new Error("Invalid live stream state");
    state[broadcasterId] = parseEntry(rawEntry);
  }
  return state;
}

function parseEntry(value: unknown): LiveStreamStateEntry {
  // Legacy format: { "broadcasterId": "streamId" }. It did not track delivery
  // per subscriber, so treat it as already delivered everywhere.
  if (typeof value === "string" && value.length > 0) {
    return { streamId: value, deliveredTo: ["*"], alerts: [] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid live stream state");
  }

  const entry = value as Record<string, unknown>;
  if (typeof entry.streamId !== "string" || entry.streamId.length === 0) {
    throw new Error("Invalid live stream state");
  }
  if (!Array.isArray(entry.deliveredTo) || !entry.deliveredTo.every((item) => typeof item === "string")) {
    throw new Error("Invalid live stream state");
  }

  return {
    streamId: entry.streamId,
    deliveredTo: [...new Set(entry.deliveredTo as string[])],
    alerts: parseAlerts(entry.alerts),
  };
}

function parseAlerts(value: unknown): StreamAlertMessage[] {
  // State written before the ended-alert feature has no alerts array; those
  // old messages simply cannot be dimmed later.
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid live stream state");

  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Invalid live stream state");
    }
    const alert = item as Record<string, unknown>;
    if (
      typeof alert.guildId !== "string" || alert.guildId.length === 0
      || typeof alert.channelId !== "string" || alert.channelId.length === 0
      || typeof alert.messageId !== "string" || alert.messageId.length === 0
    ) {
      throw new Error("Invalid live stream state");
    }
    return { guildId: alert.guildId, channelId: alert.channelId, messageId: alert.messageId };
  });
}
