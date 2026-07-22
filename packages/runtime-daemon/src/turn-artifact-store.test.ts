import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { TurnArtifactStore, turnArtifactOwnerKey } from "./turn-artifact-store";

const temporaryRoots: string[] = [];

function createStore(options: ConstructorParameters<typeof TurnArtifactStore>[0] = {}) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "rah-turn-artifacts-"));
  temporaryRoots.push(rootDir);
  return {
    rootDir,
    store: new TurnArtifactStore({ rootDir, ...options }),
  };
}

function unifiedDiff(pathname: string, oldValue: string, newValue: string): string {
  return `diff --git a/${pathname} b/${pathname}
--- a/${pathname}
+++ b/${pathname}
@@ -1 +1 @@
-${oldValue}
+${newValue}
`;
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("replaces the authoritative snapshot for the same turn instead of accumulating patches", async () => {
  const { rootDir, store } = createStore({ staleFileGraceMs: 0 });

  const firstWrite = store.replaceTurnDiff(
    "session-1",
    "turn-1",
    unifiedDiff("src/old.ts", "old", "first"),
  );
  const secondWrite = store.replaceTurnDiff(
    "session-1",
    "turn-1",
    unifiedDiff("src/new.ts", "old", "second"),
  );
  const [, secondSummary] = await Promise.all([firstWrite, secondWrite]);
  await store.runMaintenance();

  assert.deepEqual(secondSummary.files, [
    { path: "src/new.ts", additions: 1, deletions: 1 },
  ]);
  assert.deepEqual(store.getTurnFileChanges("session-1", "turn-1").fileChanges.files, [
    { path: "src/new.ts", additions: 1, deletions: 1 },
  ]);
  assert.match(
    store.getTurnFileDiff("session-1", "turn-1", "src/new.ts").diff,
    /\+second/,
  );
  assert.throws(
    () => store.getTurnFileDiff("session-1", "turn-1", "src/old.ts"),
    /Unknown turn file/,
  );

  const storedEntries = readdirSync(rootDir, { recursive: true, encoding: "utf8" });
  assert.equal(storedEntries.filter((entry) => entry.endsWith(".diff")).length, 1);
  assert.equal(storedEntries.filter((entry) => entry.endsWith(".tmp")).length, 0);
});

test("persists frozen turn artifacts across store instances and isolates session identities", async () => {
  const { rootDir, store } = createStore();
  await store.replaceTurnDiff(
    "session-1",
    "turn-1",
    unifiedDiff("src/demo.ts", "one", "two"),
  );
  await store.replaceTurnDiff(
    "session-2",
    "turn-1",
    unifiedDiff("src/demo.ts", "one", "three"),
  );

  const reopened = new TurnArtifactStore({ rootDir });
  assert.match(
    reopened.getTurnFileDiff("session-1", "turn-1", "src/demo.ts").diff,
    /\+two/,
  );
  assert.match(
    reopened.getTurnFileDiff("session-2", "turn-1", "src/demo.ts").diff,
    /\+three/,
  );
  assert.throws(
    () => reopened.getTurnFileChanges("session-3", "turn-1"),
    /Unknown turn artifact/,
  );
});

test("uses provider thread identity across runtime resume while isolating forked threads", async () => {
  const { store } = createStore();
  const originalRuntimeId = "runtime-before-resume";
  const resumedRuntimeId = "runtime-after-resume";
  const originalOwner = turnArtifactOwnerKey(originalRuntimeId, {
    provider: "codex",
    providerSessionId: "thread-stable",
  });
  const resumedOwner = turnArtifactOwnerKey(resumedRuntimeId, {
    provider: "codex",
    providerSessionId: "thread-stable",
  });
  const forkOwner = turnArtifactOwnerKey("runtime-fork", {
    provider: "codex",
    providerSessionId: "thread-fork",
  });

  assert.equal(resumedOwner, originalOwner);
  assert.notEqual(forkOwner, originalOwner);

  await store.replaceTurnDiff(
    originalOwner,
    "turn-1",
    unifiedDiff("src/demo.ts", "one", "two"),
  );

  const resumedChanges = store.getTurnFileChanges(
    resumedOwner,
    "turn-1",
    resumedRuntimeId,
  );
  assert.equal(resumedChanges.sessionId, resumedRuntimeId);
  assert.deepEqual(resumedChanges.fileChanges.files, [
    { path: "src/demo.ts", additions: 1, deletions: 1 },
  ]);
  assert.throws(
    () => store.getTurnFileChanges(forkOwner, "turn-1", "runtime-fork"),
    /Unknown turn artifact/,
  );
});

test("bounds stored data per file and per turn without splitting UTF-8 output", async () => {
  const { rootDir, store } = createStore({ maxFileBytes: 80, maxTurnBytes: 100 });
  const diff = `${unifiedDiff("src/a.ts", "旧".repeat(40), "新".repeat(40))}
${unifiedDiff("src/b.ts", "before".repeat(20), "after".repeat(20))}`;

  await store.replaceTurnDiff("session-1", "turn-1", diff);

  const changes = store.getTurnFileChanges("session-1", "turn-1");
  assert.equal(changes.truncated, true);
  assert.equal(changes.fileChanges.files.length, 2);
  const first = store.getTurnFileDiff("session-1", "turn-1", "src/a.ts");
  const second = store.getTurnFileDiff("session-1", "turn-1", "src/b.ts");
  assert.equal(first.truncated, true);
  assert.equal(second.truncated, true);
  assert.doesNotMatch(first.diff, /\uFFFD/);
  assert.doesNotMatch(second.diff, /\uFFFD/);

  const totalBytes = [first.diff, second.diff].reduce(
    (sum, value) => sum + Buffer.byteLength(value, "utf8"),
    0,
  );
  assert.ok(totalBytes <= 100);
  const manifests = readdirSync(rootDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith("manifest.json"));
  assert.equal(manifests.length, 1);
  const manifestPath = path.join(rootDir, manifests[0]!);
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).truncated, true);
});

test("reports a damaged frozen artifact instead of exposing a filesystem read error", async () => {
  const { rootDir, store } = createStore();
  await store.replaceTurnDiff(
    "session-1",
    "turn-1",
    unifiedDiff("src/demo.ts", "one", "two"),
  );

  const storedEntries = readdirSync(rootDir, { recursive: true, encoding: "utf8" });
  const diffPath = storedEntries.find((entry) => entry.endsWith(".diff"));
  assert.ok(diffPath);
  rmSync(path.join(rootDir, diffPath), { force: true });

  assert.throws(
    () => store.getTurnFileDiff("session-1", "turn-1", "src/demo.ts"),
    /Turn artifact manifest is invalid/,
  );
});

test("maintenance eventually removes damaged artifact directories", async () => {
  const { rootDir, store } = createStore({
    maxAgeMs: 0,
    staleFileGraceMs: 0,
  });
  await store.replaceTurnDiff(
    "session-1",
    "turn-1",
    unifiedDiff("src/demo.ts", "one", "two"),
  );
  const manifestEntry = readdirSync(rootDir, {
    recursive: true,
    encoding: "utf8",
  }).find((entry) => entry.endsWith("manifest.json"));
  assert.ok(manifestEntry);
  const turnDir = path.dirname(path.join(rootDir, manifestEntry));
  writeFileSync(path.join(turnDir, "manifest.json"), "{ damaged", "utf8");

  await store.runMaintenance();

  assert.equal(existsSync(turnDir), false);
});

test("zero retention removes valid artifacts without depending on filesystem clock precision", async () => {
  const logicalNow = Date.parse("2026-07-17T00:00:00.000Z");
  const { rootDir, store } = createStore({
    maxAgeMs: 0,
    now: () => logicalNow,
  });
  await store.replaceTurnDiff(
    "session-1",
    "turn-1",
    unifiedDiff("src/demo.ts", "one", "two"),
  );

  await store.runMaintenance();

  assert.equal(
    readdirSync(rootDir, { recursive: true, encoding: "utf8" })
      .some((entry) => entry.endsWith("manifest.json")),
    false,
  );
});

test("maintenance prunes expired artifacts and keeps the newest per-session snapshots", async () => {
  let now = Date.parse("2026-07-17T00:00:00.000Z");
  const { store } = createStore({
    maxArtifactsPerSession: 2,
    maxArtifacts: 10,
    maxAgeMs: 1_000,
    staleFileGraceMs: 0,
    now: () => now,
  });

  await store.replaceTurnDiff(
    "session-1",
    "turn-old",
    unifiedDiff("src/old.ts", "one", "two"),
  );
  now += 750;
  await store.replaceTurnDiff(
    "session-1",
    "turn-middle",
    unifiedDiff("src/middle.ts", "one", "two"),
  );
  now += 750;
  await store.replaceTurnDiff(
    "session-1",
    "turn-new",
    unifiedDiff("src/new.ts", "one", "two"),
  );

  await store.runMaintenance();

  assert.throws(
    () => store.getTurnFileChanges("session-1", "turn-old"),
    /Unknown turn artifact/,
  );
  assert.deepEqual(
    store.getTurnFileChanges("session-1", "turn-middle").fileChanges.files,
    [{ path: "src/middle.ts", additions: 1, deletions: 1 }],
  );
  assert.deepEqual(
    store.getTurnFileChanges("session-1", "turn-new").fileChanges.files,
    [{ path: "src/new.ts", additions: 1, deletions: 1 }],
  );
});
