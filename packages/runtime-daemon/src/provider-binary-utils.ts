import { constants, statSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

function containsPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export async function resolveConfiguredBinary(
  envVar: string,
  fallback: string,
): Promise<string> {
  const raw = process.env[envVar]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!containsPathSeparator(raw)) {
    return raw;
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(`${envVar} must be a bare command or absolute path.`);
  }
  const stats = statSync(raw);
  if (!stats.isFile()) {
    throw new Error(`${envVar} must point to an executable file.`);
  }
  await access(raw, constants.X_OK);
  return raw;
}
