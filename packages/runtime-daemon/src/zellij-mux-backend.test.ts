import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createShortZellijSessionName,
  createZellijSessionNameForRahSession,
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

test("derives stable zellij session names from RAH session ids", () => {
  const name = createZellijSessionNameForRahSession(
    "019e0aaa-1111-7222-8333-abcdef123456",
  );
  assert.match(name, /^rah-019e0aaa-[0-9a-f]{24}$/);
  assert.equal(name.length, "rah-019e0aaa-".length + 24);
  assert.equal(
    createZellijSessionNameForRahSession("019e0aaa-1111-7222-8333-abcdef123457") ===
      name,
    false,
  );
});

test("uses a short zellij socket dir from RAH_ZELLIJ_SOCKET_DIR when configured", () => {
  const backend = new ZellijMuxBackend({
    env: {
      ...process.env,
      RAH_ZELLIJ_SOCKET_DIR: "/tmp/rah-zellij-custom",
    },
  });
  assert.equal(backend.getSocketDir(), "/tmp/rah-zellij-custom");
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

    assert.ok(
      (await backend.listSessions()).some((session) => session.sessionName === sessionName),
    );

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

test("zellij mux backend writes raw terminal bytes without interpreting escape sequences", async (t) => {
  const socketDir = path.join(os.tmpdir(), `rah-zellij-raw-${process.pid}`);
  const backend = new ZellijMuxBackend({ socketDir });
  if (await skipIfZellijUnavailable(t, backend)) {
    return;
  }

  const sessionName = createShortZellijSessionName("rz");
  try {
    const created = await backend.createSession({
      sessionName,
      cwd: process.cwd(),
      title: "rah-zellij-raw",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdin.setRawMode?.(true)",
          "process.stdin.resume()",
          "process.stdout.write('RAW_READY\\n')",
          "process.stdin.on('data', (chunk) => {",
          "  process.stdout.write('RAW_HEX:' + [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' ') + '\\n')",
          "  if (chunk.includes(4)) process.exit(0)",
          "})",
          "setInterval(() => undefined, 1000)",
        ].join(";"),
      ],
      replaceDefaultPane: true,
    });

    await waitFor(async () =>
      (await backend.dumpScreen(sessionName, created.paneId, { full: true })).includes(
        "RAW_READY",
      ),
    );

    await backend.writeBytes(sessionName, created.paneId, "\u001b[A中\r");
    await waitFor(async () => {
      const dumped = await backend.dumpScreen(sessionName, created.paneId, { full: true });
      return /RAW_HEX:.*1b 5b 41 e4 b8 ad 0d/.test(dumped);
    });

    await backend.writeBytes(sessionName, created.paneId, "\u0004");
    await waitFor(async () => {
      const panes = await backend.listPanes(sessionName);
      return panes.some(
        (candidate) =>
          candidate.paneId === created.paneId &&
          candidate.exited &&
          candidate.exitStatus === 0,
      );
    });
  } finally {
    await backend.killSession(sessionName).catch(() => undefined);
    rmSync(socketDir, { force: true, recursive: true });
  }
});

test("zellij mux backend passes provider pane environment overrides", async (t) => {
  const socketDir = path.join(os.tmpdir(), `rah-zellij-env-${process.pid}`);
  const backend = new ZellijMuxBackend({ socketDir });
  if (await skipIfZellijUnavailable(t, backend)) {
    return;
  }

  const sessionName = createShortZellijSessionName("rz");
  try {
    const created = await backend.createSession({
      sessionName,
      cwd: process.cwd(),
      title: "rah-zellij-env",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(`ENV_VALUE:${process.env.RAH_ZELLIJ_TEST_ENV ?? ''}\\n`); setInterval(() => undefined, 1000)",
      ],
      env: {
        RAH_ZELLIJ_TEST_ENV: "env-through-zellij-pane",
      },
      replaceDefaultPane: true,
    });

    await waitFor(async () =>
      (await backend.dumpScreen(sessionName, created.paneId, { full: true })).includes(
        "ENV_VALUE:env-through-zellij-pane",
      ),
    );
  } finally {
    await backend.killSession(sessionName).catch(() => undefined);
    rmSync(socketDir, { force: true, recursive: true });
  }
});

test("zellij mux backend reports unexpected subscription exit", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-zellij-sub-exit-"));
  const fakeZellij = path.join(tmpDir, "zellij");
  writeFileSync(
    fakeZellij,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('subscribe')) {",
      "  console.log(JSON.stringify({ event: 'pane_update', pane_id: 'terminal_1', is_initial: true, viewport: ['SUB_READY'] }));",
      "  process.exit(7);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  chmodSync(fakeZellij, 0o755);
  const backend = new ZellijMuxBackend({ binary: fakeZellij, socketDir: path.join(tmpDir, "sock") });
  const updates: string[] = [];
  const exits: Array<{ code?: number | null; error?: Error }> = [];

  try {
    const subscription = backend.subscribePane(
      "rah-sub-exit",
      "terminal_1",
      (update) => updates.push(update.viewport.join("\n")),
      {
        onExit: (exit) => exits.push(exit),
      },
    );
    await waitFor(() => updates.some((update) => update.includes("SUB_READY")));
    await waitFor(() => exits.length > 0);
    subscription.close();
    assert.equal(exits[0]?.code, 7);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
