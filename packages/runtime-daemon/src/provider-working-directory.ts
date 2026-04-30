import { stat } from "node:fs/promises";
import { statSync, type Stats } from "node:fs";

function directoryError(label: string, cwd: string): Error {
  return new Error(`${label} does not exist: ${cwd}`);
}

function assertDirectoryStats(stats: Stats, label: string, cwd: string): void {
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${cwd}`);
  }
}

export async function assertExistingWorkingDirectory(
  cwd: string,
  label = "Working directory",
): Promise<void> {
  try {
    assertDirectoryStats(await stat(cwd), label, cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw directoryError(label, cwd);
    }
    throw error;
  }
}

export function assertExistingWorkingDirectorySync(
  cwd: string,
  label = "Working directory",
): void {
  try {
    assertDirectoryStats(statSync(cwd), label, cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw directoryError(label, cwd);
    }
    throw error;
  }
}
