import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveRahTmuxOwnerScope,
  selectRahTmuxCleanupTargets,
} from "./tmux-session-ownership";

test("tmux ownership scope is stable per RAH home", () => {
  assert.equal(resolveRahTmuxOwnerScope("/tmp/rah-a"), resolveRahTmuxOwnerScope("/tmp/rah-a"));
  assert.notEqual(resolveRahTmuxOwnerScope("/tmp/rah-a"), resolveRahTmuxOwnerScope("/tmp/rah-b"));
});

test("tmux janitor only selects dead owners in its own scope", () => {
  const targets = selectRahTmuxCleanupTargets(
    [
      { sessionName: "rah-dead", ownerScope: "scope-a", ownerPid: 101 },
      { sessionName: "rah-live", ownerScope: "scope-a", ownerPid: 102 },
      { sessionName: "rah-other-home", ownerScope: "scope-b", ownerPid: 103 },
      { sessionName: "rah-legacy" },
      { sessionName: "not-rah", ownerScope: "scope-a", ownerPid: 101 },
    ],
    {
      ownerScope: "scope-a",
      currentPid: 100,
      isOwnerAlive: (pid) => pid === 102 || pid === 103,
    },
  );
  assert.deepEqual(targets.map((session) => session.sessionName), ["rah-dead"]);
});

test("tmux janitor keeps managed sessions and only includes current owner during shutdown", () => {
  const sessions = [
    { sessionName: "rah-managed", ownerScope: "scope-a", ownerPid: 100 },
    { sessionName: "rah-current-leftover", ownerScope: "scope-a", ownerPid: 100 },
  ];
  const managedSessionNames = new Set(["rah-managed"]);

  assert.deepEqual(
    selectRahTmuxCleanupTargets(sessions, {
      ownerScope: "scope-a",
      currentPid: 100,
      managedSessionNames,
      isOwnerAlive: () => true,
    }),
    [],
  );
  assert.deepEqual(
    selectRahTmuxCleanupTargets(sessions, {
      ownerScope: "scope-a",
      currentPid: 100,
      managedSessionNames,
      includeCurrentDaemon: true,
      isOwnerAlive: () => true,
    }).map((session) => session.sessionName),
    ["rah-current-leftover"],
  );
});
