import assert from "node:assert/strict";
import test from "node:test";
import { runtimeStateFromCodexThreadStatus } from "./codex-thread-status";

test("maps Codex thread status to canonical runtime state", () => {
  assert.equal(
    runtimeStateFromCodexThreadStatus({ type: "notLoaded" }),
    "starting",
  );
  assert.equal(runtimeStateFromCodexThreadStatus({ type: "idle" }), "idle");
  assert.equal(
    runtimeStateFromCodexThreadStatus({ type: "systemError" }),
    "failed",
  );
  assert.equal(
    runtimeStateFromCodexThreadStatus({ type: "active", activeFlags: [] }),
    "running",
  );
  assert.equal(
    runtimeStateFromCodexThreadStatus({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    }),
    "waiting_permission",
  );
  assert.equal(
    runtimeStateFromCodexThreadStatus({
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    }),
    "waiting_input",
  );
});

test("ignores unknown Codex thread status shapes", () => {
  assert.equal(runtimeStateFromCodexThreadStatus(null), undefined);
  assert.equal(runtimeStateFromCodexThreadStatus({ type: "future" }), undefined);
  assert.equal(
    runtimeStateFromCodexThreadStatus({ type: "active", activeFlags: "waitingOnApproval" }),
    "running",
  );
});
