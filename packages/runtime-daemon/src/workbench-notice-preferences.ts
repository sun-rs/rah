import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeCompatibilityNoticeStateResponse } from "@rah/runtime-protocol";

const NOTICE_PREFERENCES_FILE = "workbench-notice-preferences.json";
const STORAGE_VERSION = 1;

type WorkbenchNoticePreferencesFile = {
  version: number;
  updatedAt: string;
  runtimeCompatibilityMutedUntil?: string;
};

function resolveDaemonDir(): string {
  return path.join(process.env.RAH_HOME ?? path.join(os.homedir(), ".rah"), "runtime-daemon");
}

function validFutureTimestamp(value: unknown, now: Date): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime()
    ? new Date(timestamp).toISOString()
    : undefined;
}

function nextHostMidnight(now: Date): Date {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export class WorkbenchNoticePreferencesStore {
  private readonly rootDir: string;
  private readonly filePath: string;
  private runtimeCompatibilityMutedUntil: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(rootDir = resolveDaemonDir()) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, NOTICE_PREFERENCES_FILE);
    mkdirSync(rootDir, { recursive: true });
  }

  load(now = new Date()): void {
    if (!existsSync(this.filePath)) {
      this.runtimeCompatibilityMutedUntil = undefined;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        runtimeCompatibilityMutedUntil?: unknown;
      };
      this.runtimeCompatibilityMutedUntil = validFutureTimestamp(
        parsed.runtimeCompatibilityMutedUntil,
        now,
      );
    } catch {
      this.runtimeCompatibilityMutedUntil = undefined;
    }
  }

  runtimeCompatibilityState(now = new Date()): RuntimeCompatibilityNoticeStateResponse {
    const mutedUntil = validFutureTimestamp(this.runtimeCompatibilityMutedUntil, now);
    if (!mutedUntil) {
      this.runtimeCompatibilityMutedUntil = undefined;
      return {};
    }
    return { mutedUntil };
  }

  muteRuntimeCompatibilityForToday(
    now = new Date(),
  ): RuntimeCompatibilityNoticeStateResponse {
    const mutedUntil = nextHostMidnight(now).toISOString();
    this.runtimeCompatibilityMutedUntil = mutedUntil;
    this.persist();
    return { mutedUntil };
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private persist(): void {
    const payload: WorkbenchNoticePreferencesFile = {
      version: STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      ...(this.runtimeCompatibilityMutedUntil
        ? { runtimeCompatibilityMutedUntil: this.runtimeCompatibilityMutedUntil }
        : {}),
    };
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(this.rootDir, { recursive: true });
        await writeJsonAtomic(this.filePath, payload);
      })
      .catch((error) => {
        console.error("[rah:workbench-notice-preferences] write failed", error);
      });
  }
}
