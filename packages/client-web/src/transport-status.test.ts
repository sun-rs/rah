import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSPORT_OFFLINE_ESCALATE_MS,
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

test("transport status shows a non-actionable syncing notice before escalating", () => {
  const status = syncingTransportStatus(1_000);
  const descriptor = describeTransportStatus(
    status,
    1_000 + TRANSPORT_SYNC_VISIBLE_DELAY_MS,
    { selectedSession: true },
  );

  assert.equal(descriptor?.title, "Syncing");
  assert.equal(descriptor?.tone, "info");
  assert.equal(descriptor?.primaryAction, undefined);
  assert.match(descriptor?.body ?? "", /missed session output/);
});

test("transport status escalates long reconnects to a connection issue", () => {
  const status = offlineTransportStatus(syncingTransportStatus(1_000), "offline", 1_100);
  const descriptor = describeTransportStatus(status, 1_000 + TRANSPORT_OFFLINE_ESCALATE_MS);

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
