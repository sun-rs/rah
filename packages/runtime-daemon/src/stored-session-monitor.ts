import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";

type StoredSessionMonitorOptions = {
  roots: string[];
  refresh: () => void | Promise<void>;
  debounceMs?: number;
  reconcileMs?: number;
  watchFs?: boolean;
  watchFileChanges?: boolean;
};

async function resolveWatchTarget(
  root: string,
): Promise<{ path: string; recursive: boolean } | null> {
  let candidate = path.resolve(root);
  const filesystemRoot = path.parse(candidate).root;
  while (candidate !== filesystemRoot) {
    try {
      const stats = await fs.stat(candidate);
      return {
        path: candidate,
        recursive: stats.isDirectory(),
      };
    } catch (error) {
      if (!isMissingPathError(error)) {
        return null;
      }
    }
    candidate = path.dirname(candidate);
  }
  return null;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

/**
 * Maintains a warmed in-memory view of stored-session metadata.
 *
 * Watchers are best-effort; periodic reconcile remains the authoritative path so
 * missed fs events do not leave the daemon permanently stale.
 */
export class StoredSessionMonitor {
  private readonly roots: string[];
  private readonly refresh: () => void | Promise<void>;
  private readonly debounceMs: number;
  private readonly reconcileMs: number;
  private readonly watchFs: boolean;
  private readonly watchFileChanges: boolean;
  private readonly watchers: FSWatcher[] = [];
  private readonly installedWatcherTargets = new Set<string>();

  private started = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private refreshInFlight = false;
  private refreshQueued = false;
  private watcherInstallInFlight = false;
  private watcherInstallQueued = false;

  constructor(options: StoredSessionMonitorOptions) {
    this.roots = [...new Set(options.roots.map((root) => path.resolve(root)))];
    this.refresh = options.refresh;
    this.debounceMs = options.debounceMs ?? 2_000;
    this.reconcileMs = options.reconcileMs ?? 300_000;
    this.watchFs = options.watchFs ?? false;
    this.watchFileChanges = options.watchFileChanges ?? false;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.watchFs) {
      this.scheduleWatcherInstall();
    }
    this.reconcileTimer = setInterval(() => {
      if (this.watchFs) {
        this.scheduleWatcherInstall();
      }
      this.scheduleRefresh();
    }, this.reconcileMs);
    this.reconcileTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    this.started = false;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    while (this.watchers.length > 0) {
      this.watchers.pop()?.close();
    }
    this.installedWatcherTargets.clear();
    this.watcherInstallQueued = false;
  }

  scheduleRefresh(): void {
    if (!this.started) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.runRefresh();
    }, this.debounceMs);
    this.refreshTimer.unref?.();
  }

  private scheduleWatcherInstall(): void {
    if (!this.started) {
      return;
    }
    if (this.watcherInstallInFlight) {
      this.watcherInstallQueued = true;
      return;
    }
    this.watcherInstallInFlight = true;
    void this.installWatchers()
      .catch(() => undefined)
      .finally(() => {
        this.watcherInstallInFlight = false;
        if (this.watcherInstallQueued && this.started) {
          this.watcherInstallQueued = false;
          this.scheduleWatcherInstall();
        }
      });
  }

  private async installWatchers(): Promise<void> {
    const targets = await Promise.all(this.roots.map((root) => resolveWatchTarget(root)));
    if (!this.started) {
      return;
    }
    for (const target of targets) {
      if (!target || this.installedWatcherTargets.has(target.path)) {
        continue;
      }
      const watcher = this.openWatcher(target);
      if (watcher) {
        watcher.unref?.();
        this.watchers.push(watcher);
        this.installedWatcherTargets.add(target.path);
      }
    }
  }

  private openWatcher(target: { path: string; recursive: boolean }): FSWatcher | null {
    const handleChange = (eventType?: string) => {
      if (eventType && eventType !== "rename" && !this.watchFileChanges) {
        return;
      }
      this.scheduleRefresh();
    };
    try {
      const watcher = watch(target.path, { recursive: target.recursive }, handleChange);
      watcher.on("error", () => {
        this.installedWatcherTargets.delete(target.path);
        handleChange();
      });
      return watcher;
    } catch {
      try {
        const watcher = watch(target.path, handleChange);
        watcher.on("error", () => {
          this.installedWatcherTargets.delete(target.path);
          handleChange();
        });
        return watcher;
      } catch {
        return null;
      }
    }
  }

  private async runRefresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      await this.refresh();
    } finally {
      this.refreshInFlight = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.scheduleRefresh();
      }
    }
  }
}
