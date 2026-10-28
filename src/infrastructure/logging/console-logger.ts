import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LoggerPort } from "../../domain/ports/logger.js";

const levels = { error: 0, warn: 1, info: 2, debug: 3 } as const;

/**
 * Escribe siempre en consola (journal en producción) y, si hay `logFile`,
 * también en ese fichero, como el resto de servicios (`/var/log/<servicio>.log`).
 */
export function createLogger(levelName: string, logFile: string | null = null): LoggerPort {
  const level = levels[levelName as keyof typeof levels] ?? levels.info;
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });

  const toFile = (label: string, message: string): void => {
    if (!logFile) return;
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${label}] ${message}\n`);
    } catch (error) {
      // Un log que no se puede escribir no debe tumbar el bot: queda en el journal.
      console.error(`[ERROR] Cannot write log file ${logFile}: ${(error as Error).message}`);
    }
  };

  return {
    info(message) {
      if (level < levels.info) return;
      console.info(`[INFO] ${message}`);
      toFile("INFO", message);
    },
    warn(message) {
      if (level < levels.warn) return;
      console.warn(`[WARN] ${message}`);
      toFile("WARN", message);
    },
    error(message) {
      console.error(`[ERROR] ${message}`);
      toFile("ERROR", message);
    },
  };
}
