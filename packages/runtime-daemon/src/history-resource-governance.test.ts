import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

test("provider history processes share one process-wide admission lane", () => {
  assert.match(
    source("./claude-history-page-store.ts"),
    /sharedHistoryWorkloadScheduler/,
  );
  assert.match(
    source("./codex-turn-directory.ts"),
    /sharedHistoryWorkloadScheduler/,
  );
  assert.match(
    source("./stored-session-catalog.ts"),
    /sharedHistoryWorkloadScheduler/,
  );
  assert.match(
    source("./opencode-stored-sessions.ts"),
    /sharedHistoryWorkloadScheduler/,
  );
  assert.doesNotMatch(
    source("./opencode-stored-sessions.ts"),
    /openCodeBackgroundScheduler|new BoundedTaskScheduler/,
  );
  assert.match(
    source("./history-workload-governor.ts"),
    /MAX_HISTORY_CONCURRENCY[\s\S]*RAH_HISTORY_WORKERS[\s\S]*MAX_HISTORY_CONCURRENCY/,
  );
});

test("heavy history parsing runs in low-priority child processes, never daemon worker threads", () => {
  for (const name of [
    "./claude-history-page-store.ts",
    "./codex-turn-directory.ts",
    "./stored-session-catalog.ts",
  ]) {
    const implementation = source(name);
    assert.match(implementation, /runBackgroundIpcTask/);
    assert.doesNotMatch(implementation, /node:worker_threads|new Worker\(/);
  }
  for (const name of [
    "./claude-history-page-worker.ts",
    "./codex-turn-directory-worker.ts",
    "./stored-session-catalog-worker.ts",
  ]) {
    const implementation = source(name);
    assert.match(implementation, /serveBackgroundIpcTask/);
    assert.doesNotMatch(implementation, /node:worker_threads|parentPort|workerData/);
  }
  const transport = source("./background-ipc-task.ts");
  assert.match(transport, /backgroundProcessLaunch/);
  assert.match(transport, /applyBackgroundProcessPriority/);
  assert.match(transport, /maxResponseBytes/);
  assert.match(transport, /--max-old-space-size=/);
});

test("Claude conversation hot paths never fall back to synchronous catalog discovery", () => {
  const adapter = source("./claude-stored-history-adapter.ts");
  const hotPath = adapter.slice(
    adapter.indexOf("getConversationEvidencePage("),
    adapter.indexOf("hydrateStoredSessionsCatalog("),
  );
  assert.match(hotPath, /indexedRecordForRuntimeSession/);
  assert.doesNotMatch(
    hotPath,
    /findClaudeStoredSessionRecord|discoverClaudeStoredSessions|refreshStoredSessionIndex/,
  );
  const indexedLookup = adapter.slice(
    adapter.indexOf("private indexedRecordForRuntimeSession("),
    adapter.lastIndexOf("\n}"),
  );
  assert.match(indexedLookup, /storedSessionIndex\.get\(providerSessionId\)/);
  assert.doesNotMatch(
    indexedLookup,
    /findClaudeStoredSessionRecord|discoverClaudeStoredSessions/,
  );
});

test("provider adapters are hydrated catalog views with no synchronous discovery backdoor", () => {
  const contract = source("./provider-adapter.ts");
  const sessionList = source("./runtime-session-list.ts");
  assert.doesNotMatch(contract, /refreshStoredSessionsCatalog/);
  assert.doesNotMatch(sessionList, /refreshStoredSessionsCatalog/);

  for (const name of [
    "./claude-stored-history-adapter.ts",
    "./codex-stored-history-adapter.ts",
    "./opencode-stored-history-adapter.ts",
  ]) {
    const adapter = source(name);
    assert.match(adapter, /hydrateStoredSessionsCatalog/);
    assert.doesNotMatch(
      adapter,
      /discover(?:Claude|Codex|OpenCode)StoredSessions|refreshStoredSessionIndex/,
    );
  }
  assert.doesNotMatch(
    source("./claude-stored-history-adapter.ts"),
    /findClaudeStoredSessionRecord|waitForClaudeStoredSessionRecord/,
  );
});

test("Codex conversation hot paths never fall back to synchronous catalog discovery", () => {
  const adapter = source("./codex-stored-history-adapter.ts");
  const hotPath = adapter.slice(
    adapter.indexOf("getConversationEvidencePage("),
    adapter.indexOf("listStoredSessions()"),
  );
  assert.match(hotPath, /findRecordForRuntimeSession/);
  assert.doesNotMatch(
    hotPath,
    /findCodexStoredSessionRecord|discoverCodexStoredSessions|refreshStoredSessionIndex/,
  );
  const indexedLookup = adapter.slice(
    adapter.indexOf("private findRecordForRuntimeSession("),
    adapter.indexOf("private peekCanFinalizeStoredHistory("),
  );
  assert.match(indexedLookup, /storedSessionIndex\.get\(providerSessionId\)/);
  assert.doesNotMatch(
    indexedLookup,
    /findCodexStoredSessionRecord|discoverCodexStoredSessions|refreshStoredSessionIndex/,
  );
  const liveness = source("./codex-history-liveness.ts");
  assert.match(liveness, /sharedHistoryWorkloadScheduler/);
  assert.match(liveness, /from "node:fs\/promises"/);
  assert.doesNotMatch(liveness, /statSync|new BoundedTaskScheduler/);
});

test("OpenCode conversation hot paths never start SQLite discovery on cache miss", () => {
  const adapter = source("./opencode-stored-history-adapter.ts");
  const indexedLookup = adapter.slice(
    adapter.indexOf("private async findRecordForRuntimeSession("),
    adapter.indexOf("private async findRecord("),
  );
  assert.match(indexedLookup, /storedSessionIndex\.get\(providerSessionId\)/);
  assert.doesNotMatch(
    indexedLookup,
    /findOpenCodeStoredSessionRecordAsync|discoverOpenCodeStoredSessions|refreshStoredSessionIndex/,
  );
});

test("explicit stored replay misses are reconciled by the child-process catalog", () => {
  const runtime = source("./runtime-engine.ts");
  const resume = runtime.slice(
    runtime.indexOf("private async resumeStoredReplaySession("),
    runtime.indexOf("private assertStructuredLiveBackendAllowed("),
  );
  assert.match(resume, /ensureStoredSessionCatalogRecord/);
  const ensure = runtime.slice(
    runtime.indexOf("private async ensureStoredSessionCatalogRecord("),
    runtime.indexOf("private assertStructuredLiveBackendAllowed("),
  );
  assert.match(ensure, /await this\.refreshStoredSessionsCatalog\(\{ provider \}\)/);
});

test("workspace and stored-session monitoring keep filesystem discovery off the daemon event loop", () => {
  const workspace = source("./workspace-path-utils.ts");
  assert.match(workspace, /await fs\.readdir/);
  assert.doesNotMatch(workspace, /readdirSync|statSync|existsSync/);

  const monitor = source("./stored-session-monitor.ts");
  assert.match(monitor, /await fs\.stat/);
  assert.match(monitor, /watcherInstallInFlight/);
  assert.doesNotMatch(monitor, /readdirSync|statSync|existsSync/);

  const directoryIdentity = source("./workbench-directory-utils.ts");
  assert.match(directoryIdentity, /canonicalDirectoryKeyAsync/);
  assert.match(directoryIdentity, /primeCanonicalDirectoryKeys/);
  assert.match(directoryIdentity, /await realpath/);
  assert.doesNotMatch(
    directoryIdentity,
    /existsSync|realpathSync|readdirSync|statSync/,
  );

  const authorization = source("./workspace-scope-authorizer.ts");
  assert.match(authorization, /await primeCanonicalDirectoryKeys/);
  assert.match(authorization, /await canonicalDirectoryKeyAsync/);
});

test("PTY and websocket transport enforce finite append, replay, and message budgets", () => {
  const pty = source("./pty-hub.ts");
  assert.match(pty, /DEFAULT_MAX_OUTPUT_FRAME_BYTES/);
  assert.match(pty, /DEFAULT_MAX_REPLAY_FRAME_BYTES/);
  assert.match(pty, /DEFAULT_MAX_APPEND_BYTES/);
  assert.match(pty, /utf8Tail/);
  assert.match(pty, /splitUtf8ByBytes/);

  const websocket = source("./http-server-websocket.ts");
  assert.match(websocket, /DEFAULT_MAX_WEBSOCKET_MESSAGE_BYTES/);
  assert.match(websocket, /boundedJsonByteLength\(message, maxMessageBytes\)/);
  assert.match(websocket, /socket\.close\(1009/);
});

test("provider catalogs and Codex turn directories use bounded, demand-paged transports", () => {
  const catalog = source("./stored-session-catalog.ts");
  const catalogWorker = source("./stored-session-catalog-worker.ts");
  const metadataCache = source("./stored-session-metadata-cache.ts");
  const runtime = source("./runtime-engine.ts");
  assert.match(catalog, /readStoredSessionCatalogTransfer/);
  assert.match(catalog, /createReadStream/);
  assert.match(catalog, /MAX_WORKER_RESPONSE_BYTES = 64 \* 1024/);
  assert.match(catalogWorker, /MAX_TRANSFER_ROW_BYTES/);
  assert.match(catalogWorker, /pipeline\(/);
  assert.doesNotMatch(
    `${catalog}\n${catalogWorker}`,
    /maxResponseBytes:\s*32 \* 1024 \* 1024/,
  );
  assert.match(metadataCache, /streamJsonChunks/);
  assert.match(metadataCache, /pipeline\(/);
  assert.doesNotMatch(
    metadataCache.slice(
      metadataCache.indexOf("writeStoredSessionCatalogSnapshot("),
      metadataCache.indexOf("loadStoredSessionMetadataCache("),
    ),
    /writeFileSync|renameSync|JSON\.stringify/,
  );
  assert.match(runtime, /pendingStoredSessionCatalogSnapshot/);
  assert.match(runtime, /flushStoredSessionCatalogRecords/);

  const directory = source("./codex-turn-directory.ts");
  const directoryWorker = source("./codex-turn-directory-worker.ts");
  assert.match(directoryWorker, /DIRECTORY_TRANSPORT_ITEM_LIMIT = 4_096/);
  assert.match(directoryWorker, /transportSnapshot/);
  assert.match(directoryWorker, /compactIndexedTurn/);
  assert.match(directoryWorker, /kind: "codex-turn-lookup"/);
  assert.match(directory, /runLookupWorker/);
  assert.match(directory, /hydrateSummaryPage/);
  assert.doesNotMatch(
    `${directory}\n${directoryWorker}`,
    /maxResponseBytes:\s*32 \* 1024 \* 1024/,
  );
});

test("Council runtime persistence uses an ordered asynchronous journal and flush boundary", () => {
  const store = source("./council/council-store.ts");
  const runtime = source("./council/council-runtime.ts");
  const runtimePersistence = store.slice(
    store.indexOf("private persist(message?: CouncilMessage)"),
    store.indexOf("private messagesForCouncil("),
  );

  assert.match(runtimePersistence, /pendingMessageAppends/);
  assert.match(runtimePersistence, /drainPersistence/);
  assert.match(runtimePersistence, /appendCouncilMessageBatch/);
  assert.match(runtimePersistence, /writeCouncilStoreSnapshot/);
  assert.match(runtimePersistence, /await yieldToEventLoop/);
  assert.doesNotMatch(
    runtimePersistence,
    /appendFileSync|writeFileSync|renameSync|rmSync|JSON\.stringify/,
  );
  assert.match(runtime, /await this\.store\.flush\(\)/);
});
