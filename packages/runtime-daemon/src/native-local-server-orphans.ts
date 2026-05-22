import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RAH_NATIVE_SERVER_OWNER = "rah";
const RAH_NATIVE_SERVER_OWNER_KEY = "RAH_NATIVE_SERVER_OWNER";
const RAH_NATIVE_SERVER_PROVIDER_KEY = "RAH_NATIVE_SERVER_PROVIDER";
const RAH_NATIVE_SERVER_DAEMON_PID_KEY = "RAH_NATIVE_SERVER_DAEMON_PID";

type RahNativeServerProvider = "codex" | "opencode";

export type ProcessEntry = {
  pid: number;
  command: string;
};

type CleanupSelectionOptions = {
  includeCurrentDaemon?: boolean;
  currentPid?: number;
  isProcessAlive?: (pid: number) => boolean;
};

export function rahNativeServerEnv(provider: RahNativeServerProvider): Record<string, string> {
  return {
    [RAH_NATIVE_SERVER_OWNER_KEY]: RAH_NATIVE_SERVER_OWNER,
    [RAH_NATIVE_SERVER_PROVIDER_KEY]: provider,
    [RAH_NATIVE_SERVER_DAEMON_PID_KEY]: String(process.pid),
  };
}

async function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") {
    return [];
  }
  const { stdout } = await execFileAsync("ps", ["eww", "-axo", "pid=,command="], {
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => {
      const match = line.trimStart().match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1]!, 10),
        command: match[2]!,
      };
    })
    .filter((entry): entry is ProcessEntry => Boolean(entry && Number.isFinite(entry.pid)));
}

function readEnvValue(command: string, key: string): string | undefined {
  const match = command.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
  return match?.[1];
}

function isMarkedRahNativeServer(entry: ProcessEntry): boolean {
  if (!entry.command.includes(`${RAH_NATIVE_SERVER_OWNER_KEY}=${RAH_NATIVE_SERVER_OWNER}`)) {
    return false;
  }
  return (
    entry.command.includes(`${RAH_NATIVE_SERVER_PROVIDER_KEY}=codex`) ||
    entry.command.includes(`${RAH_NATIVE_SERVER_PROVIDER_KEY}=opencode`)
  );
}

function readOwnerDaemonPid(entry: ProcessEntry): number | null {
  const raw = readEnvValue(entry.command, RAH_NATIVE_SERVER_DAEMON_PID_KEY);
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function selectRahNativeServerCleanupTargets(
  entries: readonly ProcessEntry[],
  options: CleanupSelectionOptions = {},
): ProcessEntry[] {
  const currentPid = options.currentPid ?? process.pid;
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  return entries.filter((entry) => {
    if (entry.pid === currentPid || !isMarkedRahNativeServer(entry)) {
      return false;
    }
    const ownerDaemonPid = readOwnerDaemonPid(entry);
    if (ownerDaemonPid === currentPid) {
      return options.includeCurrentDaemon === true;
    }
    if (ownerDaemonPid && processAlive(ownerDaemonPid)) {
      return false;
    }
    return true;
  });
}

async function terminateProcess(entry: ProcessEntry): Promise<void> {
  const signalTarget =
    entry.command.includes(`${RAH_NATIVE_SERVER_PROVIDER_KEY}=opencode`) && process.platform !== "win32"
      ? -entry.pid
      : entry.pid;
  try {
    process.kill(signalTarget, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    return;
  }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(entry.pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(signalTarget, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

export async function cleanupRahNativeServerOrphans(
  options: CleanupSelectionOptions = {},
): Promise<number[]> {
  let entries: ProcessEntry[];
  try {
    entries = await listProcesses();
  } catch (error) {
    console.warn("[rah] failed to list native local-server processes during RAH cleanup", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const closed: number[] = [];
  for (const entry of selectRahNativeServerCleanupTargets(entries, options)) {
    await terminateProcess(entry).then(
      () => {
        closed.push(entry.pid);
      },
      (error) => {
        console.warn("[rah] failed to clean RAH native local-server process", {
          pid: entry.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }
  return closed;
}
