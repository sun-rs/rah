import os from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_BACKGROUND_NICE = 10;
const DARWIN_TASKPOLICY_PATH = "/usr/sbin/taskpolicy";
const DARWIN_NICE_PATH = "/usr/bin/nice";

export type BackgroundProcessLaunch = {
  command: string;
  args: string[];
  priority: BackgroundProcessPriorityPlan;
};

export type BackgroundProcessPriorityPlan = {
  nice: number;
  platform: NodeJS.Platform;
  cpuPriorityAppliedBeforeExec: boolean;
};

export function resolveBackgroundProcessNice(
  raw = process.env.RAH_BACKGROUND_PROCESS_NICE,
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_BACKGROUND_NICE;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BACKGROUND_NICE;
  }
  return Math.max(0, Math.min(19, parsed));
}

/**
 * Build the launch command for a provider-owned process tree.
 *
 * On macOS, `nice` lowers CPU priority before provider code executes and then
 * replaces itself with the provider through exec(2). `taskpolicy program ...`
 * cannot be used as the lifecycle parent: it retains a supervising wrapper,
 * so signaling that PID can exit the wrapper while leaving an uncooperative
 * provider child alive. `applyBackgroundProcessPriority` applies Darwin's
 * background policy to the real provider PID immediately after spawn instead.
 *
 * Other platforms retain the post-spawn `setPriority` fallback below.
 */
export function backgroundProcessLaunch(
  command: string,
  args: readonly string[],
  options: {
    nice?: number;
    platform?: NodeJS.Platform;
  } = {},
): BackgroundProcessLaunch {
  const nice = Math.max(
    0,
    Math.min(19, Math.floor(options.nice ?? resolveBackgroundProcessNice())),
  );
  const platform = options.platform ?? process.platform;
  const priority: BackgroundProcessPriorityPlan = {
    nice,
    platform,
    cpuPriorityAppliedBeforeExec: nice > 0 && platform === "darwin",
  };
  if (nice === 0 || platform !== "darwin") {
    return { command, args: [...args], priority };
  }
  return {
    command: DARWIN_NICE_PATH,
    args: [
      "-n",
      String(nice),
      command,
      ...args,
    ],
    priority,
  };
}

/**
 * RAH owns these provider/background children. Lowering their scheduler
 * priority makes spawned shell commands inherit the same niceness, leaving the
 * daemon and browser responsive when a test fan-outs across every CPU core.
 *
 * The operation is deliberately best-effort: unsupported platforms or a
 * restricted host must not prevent a provider from starting.
 */
export function applyBackgroundProcessPriority(
  pid: number | undefined,
  label: string,
  plan: BackgroundProcessPriorityPlan,
): void {
  if (!pid) {
    return;
  }
  const { nice } = plan;
  if (nice === 0) {
    return;
  }

  // On Darwin `/usr/bin/nice` is the spawned process and execs the provider.
  // Calling setPriority on that transient PID races with exec and can lower
  // the wrapper first, after which `nice -n` lowers the provider a second
  // time. The launch plan makes the pre-exec/post-spawn boundary explicit so
  // CPU niceness is applied exactly once.
  if (!plan.cpuPriorityAppliedBeforeExec) {
    try {
      os.setPriority(pid, nice);
    } catch (error) {
      console.warn("[rah] unable to lower background process priority", {
        label,
        pid,
        nice,
        error,
      });
    }
  }

  if (plan.platform === "darwin") {
    // `nice` has already lowered CPU priority before provider code executes.
    // Apply the additional Darwin background I/O/QoS policy asynchronously:
    // a synchronous `taskpolicy` subprocess here would stop the daemon event
    // loop on every provider or history-worker launch.
    const policy = spawn(
      DARWIN_TASKPOLICY_PATH,
      ["-b", "-p", String(pid)],
      {
        stdio: "ignore",
        timeout: 1_000,
      },
    );
    policy.once("error", (error) => {
      console.warn("[rah] unable to lower background process priority", {
        label,
        pid,
        nice,
        error,
      });
    });
    policy.unref();
  }
}
