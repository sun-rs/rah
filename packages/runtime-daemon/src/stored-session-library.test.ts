import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import { StoredSessionLibraryStore } from "./stored-session-library";

function storedRef(providerSessionId: string): StoredSessionRef {
  return {
    provider: "claude",
    providerSessionId,
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    title: "Saved task",
    updatedAt: "2026-07-21T10:00:00.000Z",
    source: "provider_history",
  };
}

test("persists overlay archive placement and restores it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-session-library-"));
  try {
    const store = new StoredSessionLibraryStore(root);
    store.load();
    await store.archive(storedRef("session-1"), {
      backend: "rah_overlay",
      archivedAt: "2026-07-21T11:00:00.000Z",
    });

    const reloaded = new StoredSessionLibraryStore(root);
    reloaded.load();
    const archived = reloaded.project([storedRef("session-1")]);
    assert.equal(archived[0]?.libraryState?.placement, "archive");
    assert.equal(archived[0]?.libraryState?.backend, "rah_overlay");
    assert.equal(archived[0]?.libraryState?.archivedAt, "2026-07-21T11:00:00.000Z");

    await reloaded.restore({ provider: "claude", providerSessionId: "session-1" });
    assert.equal(reloaded.project([storedRef("session-1")])[0]?.libraryState, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects provider-native archives without a registry record", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-session-library-native-"));
  try {
    const store = new StoredSessionLibraryStore(root);
    store.load();
    const projected = store.project([
      {
        ...storedRef("native-1"),
        provider: "codex",
        providerState: { archived: true },
      },
    ]);
    assert.deepEqual(projected[0]?.libraryState, {
      placement: "archive",
      backend: "provider_native",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciles an old native registry record after the provider reports it restored", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-session-library-reconcile-"));
  try {
    const store = new StoredSessionLibraryStore(root);
    store.load();
    const session: StoredSessionRef = {
      ...storedRef("native-restored"),
      provider: "codex",
    };
    await store.archive(session, {
      backend: "provider_native",
      archivedAt: "2020-01-01T00:00:00.000Z",
    });

    const projected = store.project([session]);
    assert.equal(projected[0]?.libraryState, undefined);
    await store.flush();
    assert.equal(store.find(session), undefined);

    const reloaded = new StoredSessionLibraryStore(root);
    assert.deepEqual(reloaded.load(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the archive metadata snapshot when provider discovery is unavailable", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-session-library-missing-"));
  try {
    const store = new StoredSessionLibraryStore(root);
    store.load();
    await store.archive(storedRef("missing-1"), { backend: "rah_overlay" });
    const projected = store.project([]);
    assert.equal(projected[0]?.providerSessionId, "missing-1");
    assert.equal(projected[0]?.title, "Saved task");
    assert.equal(projected[0]?.libraryState?.placement, "archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serializes concurrent archive mutations without losing the latest registry state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-session-library-concurrent-"));
  try {
    const store = new StoredSessionLibraryStore(root);
    store.load();
    const firstArchive = store.archive(storedRef("session-1"), {
      backend: "rah_overlay",
    });
    const secondArchive = store.archive(storedRef("session-2"), {
      backend: "rah_overlay",
    });
    const firstRestore = store.restore({
      provider: "claude",
      providerSessionId: "session-1",
    });
    await Promise.all([firstArchive, secondArchive, firstRestore]);

    const reloaded = new StoredSessionLibraryStore(root);
    reloaded.load();
    assert.equal(reloaded.find({ provider: "claude", providerSessionId: "session-1" }), undefined);
    assert.equal(
      reloaded.find({ provider: "claude", providerSessionId: "session-2" })?.snapshot.title,
      "Saved task",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantines a corrupt archive registry", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-session-library-corrupt-"));
  try {
    writeFileSync(path.join(root, "session-library.json"), "{broken", "utf8");
    const store = new StoredSessionLibraryStore(root);
    assert.deepEqual(store.load(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
