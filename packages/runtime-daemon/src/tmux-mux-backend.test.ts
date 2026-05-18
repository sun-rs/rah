import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createShortTmuxSessionName,
  createTmuxSessionNameForRahSession,
  TmuxCommandError,
  TmuxMuxBackend,
} from "./tmux-mux-backend";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for tmux mux backend condition.");
}

async function skipIfTmuxUnavailable(
  t: TestContext,
  backend: TmuxMuxBackend,
): Promise<boolean> {
  try {
    await backend.ensureAvailable();
    return false;
  } catch (error) {
    t.skip(
      error instanceof TmuxCommandError
        ? `tmux unavailable: ${error.stderr || error.message}`
        : "tmux unavailable",
    );
    return true;
  }
}

async function waitForPaneExitedOrRemoved(
  backend: TmuxMuxBackend,
  sessionName: string,
  paneId: string,
): Promise<void> {
  await waitFor(async () => {
    const panes = await backend.listPanes(sessionName);
    const pane = panes.find((candidate) => candidate.paneId === paneId);
    return !pane || (pane.exited && pane.exitStatus === 0);
  });
}

test("creates short tmux session names for mux sessions", () => {
  const name = createShortTmuxSessionName("rah");
  assert.match(name, /^rah-[0-9a-f]{8}$/);
  assert.equal(name.length <= 16, true);
});

test("derives stable tmux session names from RAH session ids", () => {
  const name = createTmuxSessionNameForRahSession(
    "019e0aaa-1111-7222-8333-abcdef123456",
  );
  assert.match(name, /^rah-019e0aaa-[0-9a-f]{24}$/);
  assert.equal(name.length, "rah-019e0aaa-".length + 24);
  assert.equal(
    createTmuxSessionNameForRahSession("019e0aaa-1111-7222-8333-abcdef123457") ===
      name,
    false,
  );
});

test("tmux mux backend controls a fake shell pane and observes output", async (t) => {
  const backend = new TmuxMuxBackend();
  if (await skipIfTmuxUnavailable(t, backend)) {
    return;
  }

  const sessionName = createShortTmuxSessionName("rt");
  const updates: string[] = [];
  let subscription: { close: () => void } | undefined;

  try {
    const created = await backend.createSession({
      sessionName,
      cwd: process.cwd(),
      title: "rah-tmux-fake",
      command: "/bin/zsh",
      args: [
        "-lc",
        [
          "printf 'RAH_TMUX_READY\\n'",
          "while IFS= read -r line; do",
          "  printf 'RAH_TMUX_ECHO:%s\\n' \"$line\"",
          "  [ \"$line\" = exit ] && exit 0",
          "done",
        ].join("; "),
      ],
    });

    assert.equal(created.sessionName, sessionName);
    assert.match(created.paneId, /^%\d+$/);
    assert.ok(
      (await backend.listSessions()).some((session) => session.sessionName === sessionName),
    );

    await waitFor(async () =>
      (await backend.dumpScreen(sessionName, created.paneId, { full: true })).includes(
        "RAH_TMUX_READY",
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
      (update) => updates.push(update.viewport.join("\n")),
      { scrollback: 20 },
    );

    await backend.writeChars(sessionName, created.paneId, "hello from tmux");
    await backend.sendKeys(sessionName, created.paneId, ["Enter"]);

    await waitFor(() => updates.some((update) => update.includes("RAH_TMUX_ECHO:hello from tmux")));
    const dumped = await backend.dumpScreen(sessionName, created.paneId, { full: true });
    assert.match(dumped, /RAH_TMUX_ECHO:hello from tmux/);

    await backend.writeBytes(sessionName, created.paneId, "exit\r");
    await waitForPaneExitedOrRemoved(backend, sessionName, created.paneId);
  } finally {
    subscription?.close();
    await backend.killSession(sessionName).catch(() => undefined);
  }
});

test("tmux mux backend can place provider panes in separate tabs", async (t) => {
  const backend = new TmuxMuxBackend();
  if (await skipIfTmuxUnavailable(t, backend)) {
    return;
  }

  const sessionName = createShortTmuxSessionName("rt");
  try {
    const first = await backend.createProviderPane({
      sessionName,
      cwd: process.cwd(),
      title: "agent-one",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('AGENT_ONE_READY\\n'); setInterval(() => undefined, 1000)",
      ],
      placement: "tab",
    });
    const second = await backend.createProviderPane({
      sessionName,
      cwd: process.cwd(),
      title: "agent-two",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('AGENT_TWO_READY\\n'); setInterval(() => undefined, 1000)",
      ],
      placement: "tab",
    });

    await waitFor(async () =>
      (await backend.dumpScreen(sessionName, first.paneId, { full: true })).includes(
        "AGENT_ONE_READY",
      ),
    );
    await waitFor(async () =>
      (await backend.dumpScreen(sessionName, second.paneId, { full: true })).includes(
        "AGENT_TWO_READY",
      ),
    );

    const panes = await backend.listPanes(sessionName);
    const firstPane = panes.find((pane) => pane.paneId === first.paneId);
    const secondPane = panes.find((pane) => pane.paneId === second.paneId);
    assert.ok(firstPane);
    assert.ok(secondPane);
    assert.notEqual(firstPane.tabId, secondPane.tabId);
  } finally {
    await backend.killSession(sessionName).catch(() => undefined);
  }
});

test("tmux mux backend maps control bytes to terminal key events", async (t) => {
  const backend = new TmuxMuxBackend();
  if (await skipIfTmuxUnavailable(t, backend)) {
    return;
  }

  const sessionName = createShortTmuxSessionName("rt");
  try {
    const created = await backend.createSession({
      sessionName,
      cwd: process.cwd(),
      title: "rah-tmux-raw",
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
    });

    await waitFor(async () =>
      (await backend.dumpScreen(sessionName, created.paneId, { full: true })).includes(
        "RAW_READY",
      ),
    );

    await backend.writeBytes(sessionName, created.paneId, "\u001b[A");
    await waitFor(async () => {
      const dumped = await backend.dumpScreen(sessionName, created.paneId, { full: true });
      return /RAW_HEX:.*1b 5b 41/.test(dumped);
    });

    await backend.writeBytes(sessionName, created.paneId, "\u001b中\r");
    await waitFor(async () => {
      const dumped = await backend.dumpScreen(sessionName, created.paneId, { full: true });
      return /RAW_HEX:.*1b/.test(dumped) &&
        /RAW_HEX:.*e4 b8 ad/.test(dumped) &&
        /RAW_HEX:.*0d/.test(dumped);
    });

    await backend.writeBytes(sessionName, created.paneId, "\u0004");
    await waitForPaneExitedOrRemoved(backend, sessionName, created.paneId);
  } finally {
    await backend.killSession(sessionName).catch(() => undefined);
  }
});
