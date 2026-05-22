import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRahNativeServerCleanupTargets } from "./native-local-server-orphans";

function rahServer(args: {
  pid: number;
  provider?: "codex" | "opencode";
  daemonPid?: number | string;
}) {
  return {
    pid: args.pid,
    command: [
      "RAH_NATIVE_SERVER_OWNER=rah",
      `RAH_NATIVE_SERVER_PROVIDER=${args.provider ?? "codex"}`,
      args.daemonPid !== undefined ? `RAH_NATIVE_SERVER_DAEMON_PID=${args.daemonPid}` : "",
      "codex app-server",
    ].filter(Boolean).join(" "),
  };
}

test("native local-server janitor skips servers owned by another live daemon", () => {
  const targets = selectRahNativeServerCleanupTargets(
    [
      rahServer({ pid: 201, daemonPid: 101 }),
      rahServer({ pid: 202, daemonPid: 102 }),
    ],
    {
      currentPid: 100,
      isProcessAlive: (pid) => pid === 101,
    },
  );

  assert.deepEqual(targets.map((entry) => entry.pid), [202]);
});

test("native local-server janitor only cleans current daemon servers during shutdown", () => {
  const entries = [
    rahServer({ pid: 201, daemonPid: 100 }),
    rahServer({ pid: 202, daemonPid: 101 }),
  ];

  assert.deepEqual(
    selectRahNativeServerCleanupTargets(entries, {
      currentPid: 100,
      isProcessAlive: () => true,
    }).map((entry) => entry.pid),
    [],
  );
  assert.deepEqual(
    selectRahNativeServerCleanupTargets(entries, {
      currentPid: 100,
      includeCurrentDaemon: true,
      isProcessAlive: () => true,
    }).map((entry) => entry.pid),
    [201],
  );
});

test("native local-server janitor treats missing or invalid owner daemon pid as orphaned", () => {
  const targets = selectRahNativeServerCleanupTargets(
    [
      rahServer({ pid: 201 }),
      rahServer({ pid: 202, daemonPid: "not-a-pid" }),
    ],
    {
      currentPid: 100,
      isProcessAlive: () => true,
    },
  );

  assert.deepEqual(targets.map((entry) => entry.pid), [201, 202]);
});
