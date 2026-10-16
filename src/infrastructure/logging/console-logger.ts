import type { LoggerPort } from "../../domain/ports/logger.js";

const levels = { error: 0, warn: 1, info: 2, debug: 3 } as const;

export function createLogger(levelName: string): LoggerPort {
  const level = levels[levelName as keyof typeof levels] ?? levels.info;
  return {
    info(message) {
      if (level >= levels.info) console.info(`[INFO] ${message}`);
    },
    warn(message) {
      if (level >= levels.warn) console.warn(`[WARN] ${message}`);
    },
    error(message) {
      console.error(`[ERROR] ${message}`);
    },
  };
}
