import assert from "node:assert/strict";
import test from "node:test";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import { reconcileStoredSessionCatalogRecords } from "./stored-session-catalog-reconciliation";

function record(id: string, title: string): StoredSessionCatalogRecord {
  return {
    ref: {
      provider: "codex",
      providerSessionId: id,
      title,
      source: "provider_history",
    },
    storagePath: `/history/${id}.jsonl`,
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
