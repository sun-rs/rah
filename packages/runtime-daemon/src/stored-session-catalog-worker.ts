import { discoverClaudeStoredSessions } from "./claude-session-files.ts";
import { discoverCodexStoredSessions } from "./codex-stored-sessions.ts";
import {
  discoverOpenCodeStoredSessions,
  OpenCodeSqliteReadError,
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
      return {
        provider,
        records: discoverCodexStoredSessions().map((record) => ({
          ref: record.ref,
          storagePath: record.rolloutPath,
          archived: record.archived,
        })),
      };
    }
    if (provider === "claude") {
      return {
        provider,
        records: discoverClaudeStoredSessions().map((record) => ({
          ref: record.ref,
          storagePath: record.filePath,
        })),
      };
    }
    return {
      provider,
      records: discoverOpenCodeStoredSessions({ throwOnReadError: true }).map((record) => ({
        ref: record.ref,
        storagePath: record.databasePath,
      })),
    };
  } catch (error) {
    return {
      provider,
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
