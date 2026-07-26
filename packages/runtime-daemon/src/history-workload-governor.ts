import { BoundedTaskScheduler } from "./bounded-task-scheduler";

const DEFAULT_HISTORY_CONCURRENCY = 1;
const MAX_HISTORY_CONCURRENCY = 2;
const DEFAULT_HISTORY_QUEUE = 64;
const MAX_HISTORY_QUEUE = 128;

export const HISTORY_WORKLOAD_PRIORITY = {
  catalog: -20,
  liveness: -10,
  normal: 0,
  interactive: 10,
  liveMirror: 20,
} as const;

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), maximum)
    : fallback;
}

export function resolveHistoryWorkloadLimits(
  env: NodeJS.ProcessEnv = process.env,
): { maxConcurrency: number; maxQueued: number } {
  return {
    maxConcurrency: boundedPositiveInteger(
      env.RAH_HISTORY_WORKERS ??
        env.RAH_TURN_DIRECTORY_WORKERS ??
        env.RAH_CLAUDE_HISTORY_WORKERS,
      DEFAULT_HISTORY_CONCURRENCY,
      MAX_HISTORY_CONCURRENCY,
    ),
    maxQueued: boundedPositiveInteger(
      env.RAH_HISTORY_QUEUE ??
        env.RAH_TURN_DIRECTORY_QUEUE ??
        env.RAH_CLAUDE_HISTORY_QUEUE,
      DEFAULT_HISTORY_QUEUE,
      MAX_HISTORY_QUEUE,
    ),
  };
}

/**
 * Process-wide admission control for CPU-heavy provider-history parsing.
 *
 * Provider adapters intentionally share this lane. Giving every provider its
 * own scheduler still allows simultaneous JSONL scans to multiply CPU and
 * memory pressure, which is exactly the failure mode this boundary prevents.
 * Low-priority child processes keep parsing outside both the daemon event loop
 * and its scheduler/I/O policy domain; this scheduler keeps the number of
 * those processes globally bounded. Environment overrides are hard-clamped so
 * a stale deployment setting cannot silently dismantle admission control.
 */
export const sharedHistoryWorkloadScheduler = new BoundedTaskScheduler(
  resolveHistoryWorkloadLimits(),
);
