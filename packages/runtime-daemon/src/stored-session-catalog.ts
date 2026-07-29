import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  StoredSessionCatalogProvider,
  StoredSessionCatalogProviderResult,
  StoredSessionCatalogRecord,
  StoredSessionCatalogTransferRow,
} from "./stored-session-catalog-types";
import type { BackgroundIpcChild } from "./background-ipc-task";
import {
  runBackgroundIpcTask,
  terminateBackgroundIpcProcess,
} from "./background-ipc-task";
import { BoundedTaskScheduler } from "./bounded-task-scheduler";
import {
  HISTORY_WORKLOAD_PRIORITY,
  sharedHistoryWorkloadScheduler,
} from "./history-workload-governor";

type WorkerResponse =
  | {
      ok: true;
      recordCount: number;
      transferBytes: number;
    }
  | { ok: false; error: string };

const MAX_TRANSFER_ROW_BYTES = 1024 * 1024;
const MAX_WORKER_RESPONSE_BYTES = 64 * 1024;

const ALL_CATALOG_PROVIDERS: StoredSessionCatalogProvider[] = [
  "codex",
  "claude",
  "opencode",
];

function isCatalogProvider(
  value: unknown,
): value is StoredSessionCatalogProvider {
  return value === "codex" || value === "claude" || value === "opencode";
}

function isCatalogRecord(
  value: unknown,
  provider: StoredSessionCatalogProvider,
): value is StoredSessionCatalogRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<StoredSessionCatalogRecord>;
  return (
    typeof record.storagePath === "string" &&
    Boolean(record.ref) &&
    typeof record.ref === "object" &&
    !Array.isArray(record.ref) &&
    record.ref.provider === provider &&
    typeof record.ref.providerSessionId === "string" &&
    record.ref.providerSessionId.trim().length > 0
  );
}

function parseTransferRow(line: Buffer): StoredSessionCatalogTransferRow {
  if (line.byteLength > MAX_TRANSFER_ROW_BYTES) {
    throw new Error(
      `Stored-session catalog transfer row exceeded ${MAX_TRANSFER_ROW_BYTES} bytes.`,
    );
  }
  const parsed = JSON.parse(line.toString("utf8")) as Partial<StoredSessionCatalogTransferRow>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !isCatalogProvider(parsed.provider)
  ) {
    throw new Error("Stored-session catalog transfer contains an invalid row.");
  }
  if (parsed.kind === "record" && isCatalogRecord(parsed.record, parsed.provider)) {
    return parsed as StoredSessionCatalogTransferRow;
  }
  if (
    parsed.kind === "provider" &&
    typeof parsed.complete === "boolean" &&
    (parsed.error === undefined || typeof parsed.error === "string")
  ) {
    return parsed as StoredSessionCatalogTransferRow;
  }
  throw new Error("Stored-session catalog transfer contains an invalid row.");
}

export async function readStoredSessionCatalogTransfer(options: {
  filePath: string;
  providers: readonly StoredSessionCatalogProvider[];
  expectedRecordCount: number;
  expectedBytes: number;
  signal?: AbortSignal;
}): Promise<StoredSessionCatalogProviderResult[]> {
  const records = new Map<
    StoredSessionCatalogProvider,
    StoredSessionCatalogRecord[]
  >(options.providers.map((provider) => [provider, []]));
  const statuses = new Map<
    StoredSessionCatalogProvider,
    Omit<StoredSessionCatalogProviderResult, "provider" | "records">
  >();
  let recordCount = 0;
  let transferBytes = 0;
  let remainder = Buffer.alloc(0);

  const consumeLine = (line: Buffer) => {
    if (line.byteLength === 0) {
      return;
    }
    const row = parseTransferRow(line);
    if (!records.has(row.provider)) {
      throw new Error(
        `Stored-session catalog transfer returned unrequested provider ${row.provider}.`,
      );
    }
    if (row.kind === "record") {
      recordCount += 1;
      if (recordCount > options.expectedRecordCount) {
        throw new Error(
          "Stored-session catalog transfer returned more records than declared.",
        );
      }
      records.get(row.provider)?.push(row.record);
      return;
    }
    statuses.set(row.provider, {
      complete: row.complete,
      ...(row.error ? { error: row.error } : {}),
    });
  };

  const stream = createReadStream(options.filePath, {
    highWaterMark: 64 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk as Uint8Array);
    transferBytes += chunk.byteLength;
    let buffer =
      remainder.byteLength === 0
        ? chunk
        : Buffer.concat([remainder, chunk], remainder.byteLength + chunk.byteLength);
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline < 0) {
        break;
      }
      consumeLine(buffer.subarray(start, newline));
      start = newline + 1;
    }
    remainder =
      start === buffer.byteLength
        ? Buffer.alloc(0)
        : Buffer.from(buffer.subarray(start));
    if (remainder.byteLength > MAX_TRANSFER_ROW_BYTES) {
      throw new Error(
        `Stored-session catalog transfer row exceeded ${MAX_TRANSFER_ROW_BYTES} bytes.`,
      );
    }
    buffer = Buffer.alloc(0);
  }
  consumeLine(remainder);

  if (recordCount !== options.expectedRecordCount) {
    throw new Error(
      `Stored-session catalog transfer declared ${options.expectedRecordCount} records but contained ${recordCount}.`,
    );
  }
  if (transferBytes !== options.expectedBytes) {
    throw new Error(
      `Stored-session catalog transfer declared ${options.expectedBytes} bytes but contained ${transferBytes}.`,
    );
  }
  return options.providers.map((provider) => ({
    provider,
    records: records.get(provider) ?? [],
    ...(statuses.get(provider) ?? {
      complete: false,
      error: "Stored-session catalog transfer omitted provider status.",
    }),
  }));
}

function providerSetCovers(
  current: ReadonlySet<StoredSessionCatalogProvider>,
  requested: readonly StoredSessionCatalogProvider[],
): boolean {
  return requested.every((provider) => current.has(provider));
}

/** Serializes heavy provider catalog discovery outside the daemon event loop. */
export class StoredSessionCatalog {
  private activeWorker: BackgroundIpcChild | undefined;
  private inFlight:
    | {
        providers: Set<StoredSessionCatalogProvider>;
        controller: AbortController;
        promise: Promise<StoredSessionCatalogProviderResult[]>;
      }
    | undefined;
  private closed = false;

  constructor(
    private readonly scheduler: BoundedTaskScheduler = sharedHistoryWorkloadScheduler,
  ) {}

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

    const controller = new AbortController();
    const promise = this.scheduler
      .schedule(
        (signal) => this.runWorker(providers, signal),
        {
          signal: controller.signal,
          priority: HISTORY_WORKLOAD_PRIORITY.catalog,
        },
      )
      .finally(() => {
        if (this.inFlight?.promise === promise) {
          this.inFlight = undefined;
        }
      });
    this.inFlight = {
      providers: new Set(providers),
      controller,
      promise,
    };
    return promise;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const inFlight = this.inFlight;
    const settlement = inFlight?.promise.catch(() => []);
    inFlight?.controller.abort(
      new DOMException("Stored-session catalog closed", "AbortError"),
    );
    const worker = this.activeWorker;
    this.activeWorker = undefined;
    if (worker) {
      await terminateBackgroundIpcProcess(worker);
    }
    await settlement;
  }

  private async runWorker(
    providers: StoredSessionCatalogProvider[],
    signal: AbortSignal,
  ): Promise<StoredSessionCatalogProviderResult[]> {
    const transferRoot = await mkdtemp(
      path.join(os.tmpdir(), "rah-stored-session-catalog-"),
    );
    const outputPath = path.join(transferRoot, "catalog.jsonl");
    try {
      const response = await runBackgroundIpcTask<
        {
          kind: "stored-session-catalog";
          providers: StoredSessionCatalogProvider[];
          outputPath: string;
        },
        WorkerResponse
      >({
        script: new URL("./stored-session-catalog-worker.ts", import.meta.url),
        request: {
          kind: "stored-session-catalog",
          providers,
          outputPath,
        },
        label: "Stored-session catalog worker",
        signal,
        timeoutMs: 120_000,
        maxResponseBytes: MAX_WORKER_RESPONSE_BYTES,
        onSpawn: (worker) => {
          this.activeWorker = worker;
        },
        onClose: (worker) => {
          if (this.activeWorker === worker) {
            this.activeWorker = undefined;
          }
        },
      });
      if (response.ok) {
        return await readStoredSessionCatalogTransfer({
          filePath: outputPath,
          providers,
          expectedRecordCount: response.recordCount,
          expectedBytes: response.transferBytes,
          signal,
        });
      }
      throw new Error(response.error);
    } finally {
      await rm(transferRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}
