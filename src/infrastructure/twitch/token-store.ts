import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export async function saveTwitchTokens(
  envPath: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt?: number },
): Promise<void> {
  let content: string;
  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    content = "";
  }
  content = setEnvValue(content, "TWITCH_USER_ACCESS_TOKEN", tokens.accessToken);
  content = setEnvValue(content, "TWITCH_REFRESH_TOKEN", tokens.refreshToken);
  if (tokens.expiresAt !== undefined) {
    content = setEnvValue(content, "TWITCH_USER_TOKEN_EXPIRES_AT", String(tokens.expiresAt));
  }
  const temporaryPath = `${envPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, envPath);
    await chmod(envPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function setEnvValue(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  const separator = content.trim() ? "\n" : "";
  return `${content.replace(/\s*$/, "")}${separator}${line}\n`;
}
