import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { scanClaudeStoredSessionCatalog } from "./claude-session-files.ts";
import { scanCodexStoredSessionCatalog } from "./codex-stored-sessions.ts";
import {
  discoverOpenCodeStoredSessions,
  OpenCodeSqliteReadError,
  resolveOpenCodeDatabasePath,
} from "./opencode-stored-sessions.ts";
import type {
  StoredSessionCatalogProvider,
  StoredSessionCatalogProviderResult,
  StoredSessionCatalogTransferRow,
} from "./stored-session-catalog-types";
import { serveBackgroundIpcTask } from "./background-ipc-task";

const MAX_TRANSFER_ROW_BYTES = 1024 * 1024;

type WorkerRequest = {
  kind: "stored-session-catalog";
  providers: StoredSessionCatalogProvider[];
  outputPath: string;
};

type WorkerResponse =
  | {
      ok: true;
      recordCount: number;
      transferBytes: number;
    }
  | { ok: false; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function discoverProvider(
  provider: StoredSessionCatalogProvider,
): StoredSessionCatalogProviderResult {
  try {
    if (provider === "codex") {
      const scan = scanCodexStoredSessionCatalog();
      return {
        provider,
        complete: scan.complete,
        records: scan.records.map((record) => ({
          ref: record.ref,
          storagePath: record.rolloutPath,
          archived: record.archived,
        })),
      };
    }
    if (provider === "claude") {
      const scan = scanClaudeStoredSessionCatalog();
      return {
        provider,
        complete: scan.complete,
        records: scan.records.map((record) => ({
          ref: record.ref,
          storagePath: record.filePath,
        })),
      };
    }
    const databasePath = resolveOpenCodeDatabasePath();
    if (!existsSync(databasePath)) {
      return {
        provider,
        complete: false,
        records: [],
        error: `OpenCode database is unavailable: ${databasePath}`,
      };
    }
    return {
      provider,
      complete: true,
      records: discoverOpenCodeStoredSessions({ throwOnReadError: true }).map((record) => ({
        ref: record.ref,
        storagePath: record.databasePath,
      })),
    };
  } catch (error) {
    return {
      provider,
      complete: false,
      error:
        error instanceof OpenCodeSqliteReadError
          ? error.message
          : errorMessage(error),
    };
  }
}

function encodeTransferRow(row: StoredSessionCatalogTransferRow): string {
  const encoded = `${JSON.stringify(row)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_TRANSFER_ROW_BYTES) {
    throw new Error(
      `Stored-session catalog row exceeded ${MAX_TRANSFER_ROW_BYTES} bytes.`,
    );
  }
  return encoded;
}

async function writeTransfer(
  outputPath: string,
  results: readonly StoredSessionCatalogProviderResult[],
): Promise<{ recordCount: number; transferBytes: number }> {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  let recordCount = 0;
  let transferBytes = 0;
  async function* rows(): AsyncGenerator<string> {
    for (const result of results) {
      let rowError: string | undefined;
      let acceptedRecords = 0;
      for (const record of result.records ?? []) {
        try {
          const encoded = encodeTransferRow({
            kind: "record",
            provider: result.provider,
            record,
          });
          recordCount += 1;
          acceptedRecords += 1;
          transferBytes += Buffer.byteLength(encoded, "utf8");
          yield encoded;
        } catch (error) {
          rowError =
            error instanceof Error ? error.message : String(error);
        }
      }
      const status = encodeTransferRow({
        kind: "provider",
        provider: result.provider,
        complete:
          result.complete === true &&
          acceptedRecords === (result.records?.length ?? 0),
        ...((result.error ?? rowError)
          ? {
              error: [result.error, rowError].filter(Boolean).join("; "),
            }
          : {}),
      });
      transferBytes += Buffer.byteLength(status, "utf8");
      yield status;
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  try {
    await pipeline(
      Readable.from(rows()),
      createWriteStream(temporaryPath, {
        encoding: "utf8",
        flags: "wx",
        mode: 0o600,
      }),
    );
    await rename(temporaryPath, outputPath);
    return { recordCount, transferBytes };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function run(request: WorkerRequest): Promise<WorkerResponse> {
  const transfer = await writeTransfer(
    request.outputPath,
    request.providers.map(discoverProvider),
  );
  return {
    ok: true,
    ...transfer,
  };
}

serveBackgroundIpcTask<WorkerRequest, WorkerResponse>({
  label: "Stored-session catalog worker",
  handle: (request) => {
    if (request.kind !== "stored-session-catalog") {
      throw new Error("Invalid stored-session catalog worker request.");
    }
    return run(request);
  },
  onError: (error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }),
  maxResponseBytes: 64 * 1024,
});
