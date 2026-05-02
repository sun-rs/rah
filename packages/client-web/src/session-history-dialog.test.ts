import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import {
  dedupeStoredSessionsByIdentity,
  groupAllStoredSessionsByDirectory,
} from "./session-history-grouping";

function storedSession(overrides: Partial<StoredSessionRef> & Pick<StoredSessionRef, "provider" | "providerSessionId">): StoredSessionRef {
  return {
    provider: overrides.provider,
    providerSessionId: overrides.providerSessionId,
    source: overrides.source ?? "provider_history",
    ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
    ...(overrides.rootDir ? { rootDir: overrides.rootDir } : {}),
    ...(overrides.title ? { title: overrides.title } : {}),
    ...(overrides.preview ? { preview: overrides.preview } : {}),
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides.lastUsedAt ? { lastUsedAt: overrides.lastUsedAt } : {}),
  };
}

test("dedupes identical sessions by provider and providerSessionId", () => {
  const sessions: StoredSessionRef[] = [
    storedSession({
      provider: "gemini",
      providerSessionId: "session-1",
      source: "previous_live",
      title: "stale title",
      updatedAt: "2026-04-20T10:00:00.000Z",
    }),
    storedSession({
      provider: "gemini",
      providerSessionId: "session-1",
      source: "provider_history",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "better title",
      updatedAt: "2026-04-20T10:01:00.000Z",
    }),
  ];

  const deduped = dedupeStoredSessionsByIdentity(sessions);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.title, "better title");
  assert.equal(deduped[0]?.rootDir, "/Users/sun/Code/solars");
});

test("groups deduped sessions and counts each session only once per workspace", () => {
  const groups = groupAllStoredSessionsByDirectory([
    storedSession({
      provider: "gemini",
      providerSessionId: "session-1",
      source: "previous_live",
      title: "duplicate stale",
      updatedAt: "2026-04-20T10:00:00.000Z",
    }),
    storedSession({
      provider: "gemini",
      providerSessionId: "session-1",
      source: "provider_history",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "session one",
      updatedAt: "2026-04-20T10:01:00.000Z",
    }),
    storedSession({
      provider: "codex",
      providerSessionId: "session-2",
      rootDir: "/Users/sun/Code/solars",
      cwd: "/Users/sun/Code/solars",
      title: "session two",
      updatedAt: "2026-04-20T10:02:00.000Z",
    }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directory, "/Users/sun/Code/solars");
  assert.equal(groups[0]?.items.length, 2);
  assert.deepEqual(
    groups[0]?.items.map((session) => session.providerSessionId).sort(),
    ["session-1", "session-2"],
  );
});

test("preserves filesystem root as a real history workspace", () => {
  const groups = groupAllStoredSessionsByDirectory([
    storedSession({
      provider: "codex",
      providerSessionId: "root-session",
      rootDir: "/",
      cwd: "/",
      updatedAt: "2026-04-20T10:00:00.000Z",
    }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directory, "/");
});

test("sorts history workspaces by earliest session createdAt while keeping items newest-first", () => {
  const groups = groupAllStoredSessionsByDirectory(
    [
      storedSession({
        provider: "codex",
        providerSessionId: "session-1",
        rootDir: "/Users/sun/Code/zeta",
        cwd: "/Users/sun/Code/zeta",
        title: "older zeta",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      }),
      storedSession({
        provider: "codex",
        providerSessionId: "session-2",
        rootDir: "/Users/sun/Code/alpha",
        cwd: "/Users/sun/Code/alpha",
        title: "alpha session",
        createdAt: "2026-04-21T10:00:00.000Z",
        updatedAt: "2026-04-20T10:02:00.000Z",
      }),
      storedSession({
        provider: "codex",
        providerSessionId: "session-3",
        rootDir: "/Users/sun/Code/zeta",
        cwd: "/Users/sun/Code/zeta",
        title: "newer zeta",
        createdAt: "2026-04-22T10:00:00.000Z",
        updatedAt: "2026-04-20T10:03:00.000Z",
      }),
    ],
    {
      workspaceSortMode: "created",
    },
  );

  assert.deepEqual(
    groups.map((group) => group.directory),
    ["/Users/sun/Code/zeta", "/Users/sun/Code/alpha"],
  );
  assert.deepEqual(
    groups[0]?.items.map((session) => session.providerSessionId),
    ["session-3", "session-1"],
  );
});

test("sorts grouped sessions by lastUsedAt before updatedAt", () => {
  const groups = groupAllStoredSessionsByDirectory([
    storedSession({
      provider: "codex",
      providerSessionId: "recently-used",
      rootDir: "/Users/sun/Code/rah",
      cwd: "/Users/sun/Code/rah",
      updatedAt: "2026-04-20T10:00:00.000Z",
      lastUsedAt: "2026-04-20T10:10:00.000Z",
    }),
    storedSession({
      provider: "codex",
      providerSessionId: "recently-updated",
      rootDir: "/Users/sun/Code/rah",
      cwd: "/Users/sun/Code/rah",
      updatedAt: "2026-04-20T10:05:00.000Z",
      lastUsedAt: "2026-04-20T10:01:00.000Z",
    }),
  ]);

  assert.deepEqual(
    groups[0]?.items.map((session) => session.providerSessionId),
    ["recently-used", "recently-updated"],
  );
});
