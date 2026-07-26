import { stat } from "node:fs/promises";
import {
  BoundedTaskScheduler,
  TaskSchedulerOverloadedError,
} from "./bounded-task-scheduler";
import { runBackgroundCommand } from "./background-command";
import {
  HISTORY_WORKLOAD_PRIORITY,
  sharedHistoryWorkloadScheduler,
} from "./history-workload-governor";

const DEFAULT_ROLLOUT_STABLE_MS = 2_000;
const DEFAULT_LIVENESS_CACHE_MS = 1_000;
const DEFAULT_MAX_LIVENESS_ENTRIES = 256;

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

type CodexHistoryLivenessProbeResult = {
  lsofOutput: string;
  psOutput?: string;
};

export type CodexHistoryLivenessProbe = (
  rolloutPath: string,
  currentPid: number,
) => Promise<CodexHistoryLivenessProbeResult>;

function execFileText(
  file: string,
  args: readonly string[],
  options: { maxBuffer: number; timeout: number; allowEmptyExitOne?: boolean },
): Promise<string> {
  return runBackgroundCommand({
    command: file,
    args,
    label: `Codex history ${file}`,
    timeoutMs: options.timeout,
    maxStdoutBytes: options.maxBuffer,
    maxStderrBytes: 64 * 1024,
    acceptedExitCodes: options.allowEmptyExitOne ? [0, 1] : [0],
  }).then((result) => result.stdout);
}

async function defaultCodexHistoryLivenessProbe(
  rolloutPath: string,
  currentPid = process.pid,
): Promise<CodexHistoryLivenessProbeResult> {
  const lsofOutput = await execFileText(
    "lsof",
    ["-F", "pcfa", "--", rolloutPath],
    {
      maxBuffer: 256 * 1024,
      timeout: 500,
      allowEmptyExitOne: true,
    },
  );
  const externalWriters = externalWriterRecordsFromLsofOutput(
    lsofOutput,
    currentPid,
  );
  if (
    externalWriters.length === 0 ||
    externalWriters.some((record) => !isCodexProcessName(record.command))
  ) {
    return { lsofOutput };
  }
  const psOutput = await execFileText("ps", ["-axo", "pid=,ppid="], {
    maxBuffer: 1024 * 1024,
    timeout: 500,
  });
  return { lsofOutput, psOutput };
}

export async function hasExternalCodexRolloutWriter(
  rolloutPath: string,
  currentPid = process.pid,
): Promise<boolean> {
  try {
    const result = await defaultCodexHistoryLivenessProbe(
      rolloutPath,
      currentPid,
    );
    return (
      externalWriterRecordsFromLsofOutput(result.lsofOutput, currentPid).length >
      0
    );
  } catch {
    // Process inspection is advisory. A failed probe must be conservative.
    return true;
  }
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

export function isCodexRolloutRevisionStable(args: {
  mtimeMs: number;
  nowMs?: number;
  stableMs?: number;
}): boolean {
  return (
    (args.nowMs ?? Date.now()) - args.mtimeMs >=
    (args.stableMs ?? DEFAULT_ROLLOUT_STABLE_MS)
  );
}

export function canFinalizeCodexStoredHistory(args: {
  rolloutMtimeMs: number;
  hasRahManagedWriter: boolean;
  nowMs?: number;
  stableMs?: number;
  lsofOutput?: string;
  psOutput?: string;
}): boolean {
  if (args.hasRahManagedWriter) {
    return false;
  }
  const stable = isCodexRolloutRevisionStable({
    mtimeMs: args.rolloutMtimeMs,
    ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
    ...(args.stableMs !== undefined ? { stableMs: args.stableMs } : {}),
  });
  if (!stable) {
    return false;
  }
  const externalWriters =
    args.lsofOutput !== undefined
      ? externalWriterRecordsFromLsofOutput(args.lsofOutput)
      : undefined;
  if (externalWriters === undefined) {
    // Request paths must never synchronously spawn lsof/ps. Callers that need
    // host-process evidence use CodexHistoryLivenessTracker below.
    return false;
  }
  if (externalWriters.length === 0) {
    return true;
  }
  if (externalWriters.some((record) => !isCodexProcessName(record.command))) {
    return false;
  }
  const writerPids = [...new Set(externalWriters.map((record) => record.pid))];
  if (args.psOutput === undefined) {
    return false;
  }
  const hasActiveChild = processTableHasDescendantOf(writerPids, args.psOutput);
  return !hasActiveChild;
}

type LivenessCacheEntry = {
  revision?: string;
  value?: boolean;
  expiresAt: number;
  pending?: Promise<boolean>;
};

export type CodexHistoryLivenessTrackerOptions = {
  cacheMs?: number;
  maxEntries?: number;
  currentPid?: number;
  now?: () => number;
  probe?: CodexHistoryLivenessProbe;
  scheduler?: BoundedTaskScheduler;
};

/**
 * Keeps host-process inspection entirely off request stacks.
 *
 * `peekOrRefresh` is safe for the synchronous history-loader interface: it
 * returns only a fresh cached answer and schedules a single bounded probe
 * otherwise. `resolve` lets asynchronous page builders await the same probe.
 * Unknown, expired, overloaded, and failed probes all stay conservative.
 */
export class CodexHistoryLivenessTracker {
  private readonly cache = new Map<string, LivenessCacheEntry>();
  private readonly cacheMs: number;
  private readonly maxEntries: number;
  private readonly currentPid: number;
  private readonly now: () => number;
  private readonly probe: CodexHistoryLivenessProbe;
  private readonly scheduler: BoundedTaskScheduler;
  private readonly ownsScheduler: boolean;

  constructor(options: CodexHistoryLivenessTrackerOptions = {}) {
    this.cacheMs = Math.max(100, options.cacheMs ?? DEFAULT_LIVENESS_CACHE_MS);
    this.maxEntries = Math.max(
      1,
      options.maxEntries ?? DEFAULT_MAX_LIVENESS_ENTRIES,
    );
    this.currentPid = options.currentPid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? defaultCodexHistoryLivenessProbe;
    this.scheduler = options.scheduler ?? sharedHistoryWorkloadScheduler;
    this.ownsScheduler = false;
  }

  peekOrRefresh(args: {
    rolloutPath: string;
    hasRahManagedWriter: boolean;
    stableMs?: number;
  }): boolean {
    if (args.hasRahManagedWriter) {
      this.cache.delete(args.rolloutPath);
      return false;
    }
    const entry = this.cache.get(args.rolloutPath);
    if (
      entry?.value !== undefined &&
      entry.expiresAt > this.now()
    ) {
      this.touch(args.rolloutPath, entry);
      return entry.value;
    }
    void this.refresh(args);
    return false;
  }

  async resolve(args: {
    rolloutPath: string;
    hasRahManagedWriter: boolean;
    stableMs?: number;
  }): Promise<boolean> {
    if (args.hasRahManagedWriter) {
      this.cache.delete(args.rolloutPath);
      return false;
    }
    const entry = this.cache.get(args.rolloutPath);
    if (
      entry?.value !== undefined &&
      entry.expiresAt > this.now()
    ) {
      this.touch(args.rolloutPath, entry);
      return entry.value;
    }
    return this.refresh(args);
  }

  clear(rolloutPath?: string): void {
    if (rolloutPath !== undefined) {
      this.cache.delete(rolloutPath);
      return;
    }
    this.cache.clear();
  }

  shutdown(): void {
    this.cache.clear();
    if (this.ownsScheduler) {
      this.scheduler.shutdown();
    }
  }

  private refresh(args: {
    rolloutPath: string;
    hasRahManagedWriter: boolean;
    stableMs?: number;
  }): Promise<boolean> {
    const current = this.cache.get(args.rolloutPath);
    if (current?.pending) {
      return current.pending;
    }
    const entry: LivenessCacheEntry = {
      ...(current?.revision ? { revision: current.revision } : {}),
      expiresAt: 0,
    };
    const pending = this.scheduler
      .schedule(
        async () => {
          const now = this.now();
          const stats = await stat(args.rolloutPath);
          entry.revision = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
          if (
            !isCodexRolloutRevisionStable({
              mtimeMs: stats.mtimeMs,
              nowMs: now,
              ...(args.stableMs !== undefined
                ? { stableMs: args.stableMs }
                : {}),
            })
          ) {
            return false;
          }
          const result = await this.probe(args.rolloutPath, this.currentPid);
          return canFinalizeCodexStoredHistory({
            rolloutMtimeMs: stats.mtimeMs,
            hasRahManagedWriter: false,
            nowMs: now,
            lsofOutput: result.lsofOutput,
            ...(result.psOutput !== undefined
              ? { psOutput: result.psOutput }
              : {}),
          });
        },
        { priority: HISTORY_WORKLOAD_PRIORITY.liveness },
      )
      .catch((error) => {
        if (!(error instanceof TaskSchedulerOverloadedError)) {
          console.warn("[rah] Codex history liveness probe failed", {
            rolloutPath: args.rolloutPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return false;
      })
      .then((value) => {
        const latest = this.cache.get(args.rolloutPath);
        if (latest === entry) {
          entry.value = value;
          entry.expiresAt = this.now() + this.cacheMs;
          delete entry.pending;
          this.touch(args.rolloutPath, entry);
          this.prune();
        }
        return value;
      });
    entry.pending = pending;
    this.cache.set(args.rolloutPath, entry);
    this.prune();
    return pending;
  }

  private touch(path: string, entry: LivenessCacheEntry): void {
    this.cache.delete(path);
    this.cache.set(path, entry);
  }

  private prune(): void {
    if (this.cache.size <= this.maxEntries) {
      return;
    }
    for (const [path, entry] of this.cache) {
      if (this.cache.size <= this.maxEntries) {
        break;
      }
      if (!entry.pending) {
        this.cache.delete(path);
      }
    }
  }
}
