import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const DEFAULT_ROLLOUT_STABLE_MS = 2_000;

export interface CodexLsofFileRecord {
  pid: number;
  command?: string;
  fd?: string;
  access?: string;
}

export interface CodexProcessParentRecord {
  pid: number;
  ppid: number;
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

export function parseProcessParentRecords(output: string): CodexProcessParentRecord[] {
  const records: CodexProcessParentRecord[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const [pidRaw, ppidRaw] = rawLine.trim().split(/\s+/);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    records.push({ pid, ppid });
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

function isCodexProcessName(command: string | undefined): boolean {
  return command?.toLowerCase().includes("codex") ?? false;
}

export function externalWriterRecordsFromLsofOutput(
  output: string,
  currentPid = process.pid,
): CodexLsofFileRecord[] {
  return parseLsofFileRecords(output).filter(
    (record) => record.pid !== currentPid && recordHasWriteAccess(record),
  );
}

export function hasExternalWriterFromLsofOutput(
  output: string,
  currentPid = process.pid,
): boolean {
  return externalWriterRecordsFromLsofOutput(output, currentPid).length > 0;
}

function readExternalCodexRolloutWriterRecords(
  rolloutPath: string,
  currentPid = process.pid,
): CodexLsofFileRecord[] {
  try {
    const output = execFileSync("lsof", ["-F", "pcfa", "--", rolloutPath], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
    return externalWriterRecordsFromLsofOutput(output, currentPid);
  } catch {
    return [];
  }
}

export function hasExternalCodexRolloutWriter(
  rolloutPath: string,
  currentPid = process.pid,
): boolean {
  return readExternalCodexRolloutWriterRecords(rolloutPath, currentPid).length > 0;
}

export function processTableHasDescendantOf(
  rootPids: readonly number[],
  processTableOutput: string,
): boolean {
  const roots = new Set(rootPids.filter((pid) => Number.isInteger(pid) && pid > 0));
  if (roots.size === 0) {
    return false;
  }
  const childrenByParent = new Map<number, number[]>();
  for (const record of parseProcessParentRecords(processTableOutput)) {
    const children = childrenByParent.get(record.ppid) ?? [];
    children.push(record.pid);
    childrenByParent.set(record.ppid, children);
  }
  const seen = new Set<number>();
  const pending = [...roots];
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (!roots.has(childPid)) {
        return true;
      }
      pending.push(childPid);
    }
  }
  return false;
}

function externalCodexWritersHaveDescendants(writerPids: readonly number[]): boolean {
  if (writerPids.length === 0 || process.platform === "win32") {
    return false;
  }
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
    return processTableHasDescendantOf(writerPids, output);
  } catch {
    // If process inspection fails, stay conservative and keep the tool open.
    return true;
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
  psOutput?: string;
}): boolean {
  if (args.hasRahManagedWriter) {
    return false;
  }
  const stable = isCodexRolloutFileStable({
    rolloutPath: args.rolloutPath,
    ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
    ...(args.stableMs !== undefined ? { stableMs: args.stableMs } : {}),
  });
  if (!stable) {
    return false;
  }
  const externalWriters =
    args.lsofOutput !== undefined
      ? externalWriterRecordsFromLsofOutput(args.lsofOutput)
      : readExternalCodexRolloutWriterRecords(args.rolloutPath);
  if (externalWriters.length === 0) {
    return true;
  }
  if (externalWriters.some((record) => !isCodexProcessName(record.command))) {
    return false;
  }
  const writerPids = [...new Set(externalWriters.map((record) => record.pid))];
  const hasActiveChild =
    args.psOutput !== undefined
      ? processTableHasDescendantOf(writerPids, args.psOutput)
      : externalCodexWritersHaveDescendants(writerPids);
  return !hasActiveChild;
}
