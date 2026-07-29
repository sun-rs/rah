import assert from "node:assert/strict";
import test from "node:test";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import {
  canonicalizeStoredSessionCatalogRecords,
  reconcileStoredSessionCatalogRecords,
} from "./stored-session-catalog-reconciliation";

function record(
  id: string,
  title: string,
  options?: {
    storagePath?: string;
    archived?: boolean;
    updatedAt?: string;
  },
): StoredSessionCatalogRecord {
  return {
    ref: {
      provider: "codex",
      providerSessionId: id,
      title,
      source: "provider_history",
      ...(options?.updatedAt ? { updatedAt: options.updatedAt } : {}),
    },
    storagePath: options?.storagePath ?? `/history/${id}.jsonl`,
    ...(options?.archived !== undefined
      ? { archived: options.archived }
      : {}),
  };
}

test("incomplete provider scans can upsert but never shrink the catalog", () => {
  const reconciled = reconcileStoredSessionCatalogRecords({
    current: [record("one", "Old one"), record("two", "Two")],
    incoming: [record("one", "New one"), record("three", "Three")],
    complete: false,
  });

  assert.deepEqual(
    reconciled.map((entry) => [entry.ref.providerSessionId, entry.ref.title]),
    [
      ["one", "New one"],
      ["two", "Two"],
      ["three", "Three"],
    ],
  );
});

test("canonical snapshots keep one active row per provider identity", () => {
  const reconciled = canonicalizeStoredSessionCatalogRecords([
    record("one", "Archived", {
      storagePath: "/archive/one.jsonl",
      archived: true,
      updatedAt: "2026-07-29T12:00:00.000Z",
    }),
    record("one", "Active", {
      storagePath: "/history/one.jsonl",
      archived: false,
      updatedAt: "2026-07-29T11:00:00.000Z",
    }),
  ]);

  assert.deepEqual(
    reconciled.map((entry) => [
      entry.ref.providerSessionId,
      entry.ref.title,
      entry.storagePath,
    ]),
    [["one", "Active", "/history/one.jsonl"]],
  );
});

test("canonical snapshots choose the newest deterministic duplicate metadata", () => {
  const reconciled = canonicalizeStoredSessionCatalogRecords([
    record("one", "Old", {
      storagePath: "/history/z-one.jsonl",
      updatedAt: "2026-07-28T12:00:00.000Z",
    }),
    record("one", "New", {
      storagePath: "/history/a-one.jsonl",
      updatedAt: "2026-07-29T12:00:00.000Z",
    }),
    record(" ", "Invalid"),
  ]);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.ref.title, "New");
});

test("incomplete refresh replaces metadata in place without reordering rows", () => {
  const reconciled = reconcileStoredSessionCatalogRecords({
    current: [record("one", "One"), record("two", "Two")],
    incoming: [
      record("one", "Updated one", { archived: true }),
      record("three", "Three"),
    ],
    complete: false,
  });

  assert.deepEqual(
    reconciled.map((entry) => [entry.ref.providerSessionId, entry.ref.title]),
    [
      ["one", "Updated one"],
      ["two", "Two"],
      ["three", "Three"],
    ],
  );
  assert.equal(reconciled[0]?.archived, true);
});

test("an incomplete empty scan preserves every existing session", () => {
  const current = [record("one", "One"), record("two", "Two")];
  assert.deepEqual(
    reconcileStoredSessionCatalogRecords({ current, incoming: [], complete: false }),
    current,
  );
});

test("a complete scan is authoritative and may remove sessions", () => {
  const reconciled = reconcileStoredSessionCatalogRecords({
    current: [record("one", "One"), record("two", "Two")],
    incoming: [record("two", "Updated two")],
    complete: true,
  });

  assert.deepEqual(
    reconciled.map((entry) => [entry.ref.providerSessionId, entry.ref.title]),
    [["two", "Updated two"]],
  );
});
