import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/infrastructure/logging/console-logger.js";

describe("createLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "announcements-log-"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes to console only when no log file is configured", () => {
    const logger = createLogger("info");

    logger.info("hello");

    expect(console.info).toHaveBeenCalledWith("[INFO] hello");
  });

  it("also appends timestamped lines to the log file, creating its directory", () => {
    const logFile = join(dir, "nested", "announcements.log");
    const logger = createLogger("info", logFile);

    logger.info("started");
    logger.warn("slow");
    logger.error("boom");

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z \[INFO\] started$/);
    expect(lines[1]).toMatch(/\[WARN\] slow$/);
    expect(lines[2]).toMatch(/\[ERROR\] boom$/);
    expect(console.info).toHaveBeenCalledWith("[INFO] started");
  });

  it("respects the level for the file as well as the console", () => {
    const logFile = join(dir, "announcements.log");
    const logger = createLogger("warn", logFile);

    logger.info("hidden");
    logger.warn("shown");

    expect(readFileSync(logFile, "utf8")).not.toContain("hidden");
    expect(readFileSync(logFile, "utf8")).toContain("[WARN] shown");
    expect(console.info).not.toHaveBeenCalled();
  });

  it("keeps running and reports to console when the log file cannot be written", () => {
    const logFile = join(dir, "announcements.log");
    const logger = createLogger("info", logFile);
    rmSync(dir, { recursive: true, force: true });
    // El directorio ya no existe: appendFileSync falla y el bot debe seguir.

    expect(() => logger.info("lost")).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`Cannot write log file ${logFile}`));
    expect(existsSync(logFile)).toBe(false);
  });
});
