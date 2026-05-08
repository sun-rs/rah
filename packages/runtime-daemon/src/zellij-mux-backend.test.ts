import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createShortZellijSessionName,
  ZellijCommandError,
  ZellijMuxBackend,
} from "./zellij-mux-backend";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for zellij mux backend condition.");
}

async function skipIfZellijUnavailable(
  t: TestContext,
  backend: ZellijMuxBackend,
): Promise<boolean> {
  try {
    await backend.ensureAvailable();
    return false;
  } catch (error) {
    t.skip(
      error instanceof ZellijCommandError
        ? `zellij unavailable: ${error.stderr || error.message}`
        : "zellij unavailable",
    );
    return true;
  }
}

test("creates short zellij session names for socket-safe mux sessions", () => {
  const name = createShortZellijSessionName("rah");
  assert.match(name, /^rah-[0-9a-f]{8}$/);
  assert.equal(name.length <= 16, true);
});

test("zellij mux backend controls a fake shell pane and observes exit state", async (t) => {
  const socketDir = path.join(os.tmpdir(), `rah-zellij-test-${process.pid}`);
  const backend = new ZellijMuxBackend({ socketDir });
  if (await skipIfZellijUnavailable(t, backend)) {
    return;
  }

  const sessionName = createShortZellijSessionName("rz");
  const updates: string[] = [];
  let subscription: { close: () => void } | undefined;

  try {
    const created = await backend.createSession({
      sessionName,
      cwd: process.cwd(),
      title: "rah-zellij-fake",
      command: "/bin/zsh",
      args: [
        "-lc",
        [
          "printf 'RAH_ZELLIJ_READY\\n'",
          "while IFS= read -r line; do",
          "  printf 'RAH_ZELLIJ_ECHO:%s\\n' \"$line\"",
          "  [ \"$line\" = exit ] && exit 0",
          "done",
        ].join("; "),
      ],
      replaceDefaultPane: true,
    });

    assert.equal(created.sessionName, sessionName);
    assert.match(created.paneId, /^terminal_\d+$/);

    await waitFor(async () =>
      (await backend.dumpScreen(sessionName, created.paneId, { full: true })).includes(
        "RAH_ZELLIJ_READY",
      ),
    );

    const panes = await backend.listPanes(sessionName);
    const pane = panes.find((candidate) => candidate.paneId === created.paneId);
    assert.ok(pane);
    assert.equal(pane.exited, false);
    assert.equal(pane.isPlugin, false);

    subscription = backend.subscribePane(
      sessionName,
      created.paneId,
      (update) => updates.push([...update.scrollback ?? [], ...update.viewport].join("\n")),
      { scrollback: 20 },
    );

    await backend.writeChars(sessionName, created.paneId, "hello from zellij");
    await backend.sendKeys(sessionName, created.paneId, ["Enter"]);

    await waitFor(() => updates.some((update) => update.includes("RAH_ZELLIJ_ECHO:hello from zellij")));
    const dumped = await backend.dumpScreen(sessionName, created.paneId, { full: true });
    assert.match(dumped, /RAH_ZELLIJ_ECHO:hello from zellij/);

    await backend.writeChars(sessionName, created.paneId, "exit");
    await backend.sendKeys(sessionName, created.paneId, ["Enter"]);

    await waitFor(async () => {
      const nextPanes = await backend.listPanes(sessionName);
      return nextPanes.some(
        (candidate) =>
          candidate.paneId === created.paneId &&
          candidate.exited &&
          candidate.exitStatus === 0,
      );
    });
  } finally {
    subscription?.close();
    await backend.killSession(sessionName).catch(() => undefined);
    rmSync(socketDir, { force: true, recursive: true });
  }
});
