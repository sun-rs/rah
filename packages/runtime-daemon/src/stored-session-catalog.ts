import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  StoredSessionCatalogProvider,
  StoredSessionCatalogProviderResult,
} from "./stored-session-catalog-types";

type WorkerResponse = {
  ok: true;
  results: StoredSessionCatalogProviderResult[];
};

const ALL_CATALOG_PROVIDERS: StoredSessionCatalogProvider[] = [
  "codex",
  "claude",
  "opencode",
];

function providerSetCovers(
  current: ReadonlySet<StoredSessionCatalogProvider>,
  requested: readonly StoredSessionCatalogProvider[],
): boolean {
  return requested.every((provider) => current.has(provider));
}

function childExited(worker: ChildProcess): boolean {
  return worker.exitCode !== null || worker.signalCode !== null;
}

async function waitForChildExit(worker: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(worker)) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.off("exit", onExit);
      worker.off("error", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    worker.once("exit", onExit);
    worker.once("error", onExit);
    if (childExited(worker)) {
      finish(true);
    }
  });
}

/** Serializes heavy provider catalog discovery outside the daemon event loop. */
export class StoredSessionCatalog {
  private activeWorker: ChildProcess | undefined;
  private inFlight:
    | {
        providers: Set<StoredSessionCatalogProvider>;
        promise: Promise<StoredSessionCatalogProviderResult[]>;
      }
    | undefined;
  private closed = false;

  refresh(
    provider?: StoredSessionCatalogProvider,
  ): Promise<StoredSessionCatalogProviderResult[]> {
    if (this.closed) {
      return Promise.resolve([]);
    }
    const providers = provider ? [provider] : ALL_CATALOG_PROVIDERS;
    const current = this.inFlight;
    if (current) {
      if (providerSetCovers(current.providers, providers)) {
        return current.promise;
      }
      return current.promise.then(() => this.refresh(provider));
    }

    const promise = this.runWorker(providers).finally(() => {
      if (this.inFlight?.promise === promise) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = {
      providers: new Set(providers),
      promise,
    };
    return promise;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const worker = this.activeWorker;
    this.activeWorker = undefined;
    if (!worker || childExited(worker)) {
      return;
    }
    worker.kill("SIGTERM");
    if (await waitForChildExit(worker, 1_500)) {
      return;
    }
    worker.kill("SIGKILL");
    await waitForChildExit(worker, 1_000);
  }

  private runWorker(
    providers: StoredSessionCatalogProvider[],
  ): Promise<StoredSessionCatalogProviderResult[]> {
    return new Promise((resolve, reject) => {
      const worker = fork(
        fileURLToPath(new URL("./stored-session-catalog-worker.ts", import.meta.url)),
        [],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      worker.send({
        kind: "stored-session-catalog",
        providers,
      });
      this.activeWorker = worker;
      let settled = false;
      const finish = () => {
        if (this.activeWorker === worker) {
          this.activeWorker = undefined;
        }
      };
      worker.once("message", (message: unknown) => {
        const response = message as WorkerResponse;
        settled = true;
        finish();
        resolve(response.results);
      });
      worker.once("error", (error: Error) => {
        settled = true;
        finish();
        reject(error);
      });
      worker.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        finish();
        if (!settled) {
          reject(
            new Error(
              code === 0
                ? "Stored-session catalog worker exited without a result."
                : `Stored-session catalog worker exited with ${
                    signal ? `signal ${signal}` : `code ${code}`
                  }.`,
            ),
          );
        }
      });
    });
  }
}
