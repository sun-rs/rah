import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const DEFAULT_ROLLOUT_STABLE_MS = 2_000;

export interface CodexLsofFileRecord {
  pid: number;
  command?: string;
  fd?: string;
  access?: string;
}

export function parseLsofFileRecords(output: string): CodexLsofFileRecord[] {
  const records: CodexLsofFileRecord[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  let current: CodexLsofFileRecord | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) {
      continue;
    }
    const tag = rawLine[0];
    const value = rawLine.slice(1);
    switch (tag) {
      case "p": {
        const parsed = Number.parseInt(value, 10);
        pid = Number.isFinite(parsed) ? parsed : undefined;
        command = undefined;
        current = undefined;
        break;
      }
      case "c":
        command = value;
        if (current) {
          current.command = value;
        }
        break;
      case "f":
        if (pid === undefined) {
          current = undefined;
          break;
        }
        current = {
          pid,
          ...(command !== undefined ? { command } : {}),
          fd: value,
        };
        records.push(current);
        break;
      case "a":
        if (current) {
          current.access = value.trim();
        }
        break;
    }
  }

  return records;
}

function recordHasWriteAccess(record: CodexLsofFileRecord): boolean {
  const access = record.access?.toLowerCase();
  if (access?.includes("w") || access?.includes("u")) {
    return true;
  }
  return /[wu]$/i.test(record.fd ?? "");
}

export function hasExternalWriterFromLsofOutput(
  output: string,
  currentPid = process.pid,
): boolean {
  return parseLsofFileRecords(output).some(
    (record) => record.pid !== currentPid && recordHasWriteAccess(record),
  );
}

export function hasExternalCodexRolloutWriter(
  rolloutPath: string,
  currentPid = process.pid,
): boolean {
  try {
    const output = execFileSync("lsof", ["-F", "pcfa", "--", rolloutPath], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
    return hasExternalWriterFromLsofOutput(output, currentPid);
  } catch {
    return false;
  }
}

export function isCodexRolloutFileStable(args: {
  rolloutPath: string;
  nowMs?: number;
  stableMs?: number;
}): boolean {
  try {
    const stats = statSync(args.rolloutPath);
    return (
      (args.nowMs ?? Date.now()) - stats.mtimeMs >=
      (args.stableMs ?? DEFAULT_ROLLOUT_STABLE_MS)
    );
  } catch {
    return false;
  }
}

export function canFinalizeCodexStoredHistory(args: {
  rolloutPath: string;
  hasRahManagedWriter: boolean;
  nowMs?: number;
  stableMs?: number;
  lsofOutput?: string;
}): boolean {
  if (args.hasRahManagedWriter) {
    return false;
  }
  const hasExternalWriter =
    args.lsofOutput !== undefined
      ? hasExternalWriterFromLsofOutput(args.lsofOutput)
      : hasExternalCodexRolloutWriter(args.rolloutPath);
  if (hasExternalWriter) {
    return false;
  }
  return isCodexRolloutFileStable({
    rolloutPath: args.rolloutPath,
    ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
    ...(args.stableMs !== undefined ? { stableMs: args.stableMs } : {}),
  });
}
