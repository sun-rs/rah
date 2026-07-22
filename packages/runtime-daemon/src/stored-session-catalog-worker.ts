import { existsSync } from "node:fs";
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
} from "./stored-session-catalog-types";

type WorkerRequest = {
  kind: "stored-session-catalog";
  providers: StoredSessionCatalogProvider[];
};

type WorkerResponse = {
  ok: true;
  results: StoredSessionCatalogProviderResult[];
};

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

function run(request: WorkerRequest): void {
  const response: WorkerResponse = {
    ok: true,
    results: request.providers.map(discoverProvider),
  };
  if (!process.send) {
    return;
  }
  process.send(response, () => {
    process.disconnect?.();
  });
}

process.on("message", (message: unknown) => {
  const request = message as WorkerRequest;
  if (request.kind !== "stored-session-catalog") {
    throw new Error("Invalid stored-session catalog worker request.");
  }
  run(request);
});
