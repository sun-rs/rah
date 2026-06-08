import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSPORT_SYNC_VISIBLE_DELAY_MS,
  connectedTransportStatus,
  describeTransportStatus,
  nextReconnectTransportStatus,
  offlineTransportStatus,
  syncingTransportStatus,
} from "./transport-status";

test("transport status hides brief foreground reconnects", () => {
  const status = syncingTransportStatus(1_000);

  assert.equal(
    describeTransportStatus(status, 1_000 + TRANSPORT_SYNC_VISIBLE_DELAY_MS - 1),
    null,
  );
});

test("transport status shows a non-actionable syncing notice after a brief delay", () => {
  const status = syncingTransportStatus(1_000);
  const descriptor = describeTransportStatus(
    status,
    1_000 + TRANSPORT_SYNC_VISIBLE_DELAY_MS,
    { selectedLiveSession: true },
  );

  assert.equal(descriptor?.title, "Syncing");
  assert.equal(descriptor?.tone, "info");
  assert.equal(descriptor?.primaryAction, undefined);
  assert.match(descriptor?.body ?? "", /missed session output/);
});

test("transport status keeps long unconfirmed reconnects as syncing", () => {
  const status = syncingTransportStatus(1_000);
  const descriptor = describeTransportStatus(status, 301_000, { selectedLiveSession: true });

  assert.equal(descriptor?.title, "Syncing");
  assert.equal(descriptor?.tone, "info");
  assert.equal(descriptor?.primaryAction, undefined);
});

test("transport status does not claim missed output for non-live selections", () => {
  const status = syncingTransportStatus(1_000);
  const descriptor = describeTransportStatus(status, 1_000 + TRANSPORT_SYNC_VISIBLE_DELAY_MS, {
    selectedLiveSession: false,
  });

  assert.equal(descriptor?.title, "Syncing");
  assert.doesNotMatch(descriptor?.body ?? "", /missed session output/);
  assert.match(descriptor?.body ?? "", /session updates/);
});

test("transport status hides passive socket reconnects from the global syncing callout", () => {
  const status = nextReconnectTransportStatus(connectedTransportStatus(), "socket closed", 1_000);

  assert.equal(
    describeTransportStatus(status, 1_000 + TRANSPORT_SYNC_VISIBLE_DELAY_MS, {
      selectedLiveSession: true,
    }),
    null,
  );
});

test("transport status shows connection issue only after confirmed recovery failure", () => {
  const status = offlineTransportStatus(syncingTransportStatus(1_000), "offline", 1_100);
  const descriptor = describeTransportStatus(status, 1_100);

  assert.equal(descriptor?.title, "Connection issue");
  assert.equal(descriptor?.tone, "warning");
  assert.equal(descriptor?.primaryAction, "refresh");
  assert.equal(descriptor?.primaryLabel, "Reconnect");
});

test("transport reconnect status preserves the original reconnect start", () => {
  const first = nextReconnectTransportStatus(connectedTransportStatus(), "socket failed", 1_000);
  const second = nextReconnectTransportStatus(first, "socket failed again", 2_000);

  assert.equal(first.phase, "syncing");
  assert.equal(second.phase, "syncing");
  if (first.phase === "syncing" && second.phase === "syncing") {
    assert.equal(second.since, first.since);
  }
});
