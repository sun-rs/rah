import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createShortTmuxSessionName,
  createTmuxSessionNameForRahSession,
  createTmuxPaneShellCommand,
  nextTmuxSubscriptionPollInterval,
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

test("tmux pane commands lower the whole provider process tree priority", () => {
  const request = {
    sessionName: "rah-test",
    cwd: "/tmp",
    command: "/bin/zsh",
    args: ["-lc", "printf '%s' \"$VALUE\""],
    env: { VALUE: "provider payload" },
  };
  const background = createTmuxPaneShellCommand(request, 10, "linux");
  assert.equal(
    background,
    "VALUE='provider payload' exec nice -n 10 '/bin/zsh' '-lc' 'printf '\\''%s'\\'' \"$VALUE\"'",
  );
  assert.equal(
    createTmuxPaneShellCommand(request, 0, "linux"),
    "VALUE='provider payload' exec '/bin/zsh' '-lc' 'printf '\\''%s'\\'' \"$VALUE\"'",
  );
  assert.equal(
    createTmuxPaneShellCommand(request, 10, "darwin"),
    "VALUE='provider payload' exec /usr/sbin/taskpolicy -b nice -n 10 '/bin/zsh' '-lc' 'printf '\\''%s'\\'' \"$VALUE\"'",
  );
});

test("tmux pane subscriptions poll quickly on change and back off while idle", () => {
  assert.equal(
    nextTmuxSubscriptionPollInterval({
      currentMs: 800,
      changed: true,
      minMs: 100,
      maxMs: 1_000,
    }),
    100,
  );
  assert.equal(
    nextTmuxSubscriptionPollInterval({
      currentMs: 100,
      changed: false,
      minMs: 100,
      maxMs: 1_000,
    }),
    200,
  );
  assert.equal(
    nextTmuxSubscriptionPollInterval({
      currentMs: 800,
      changed: false,
      minMs: 100,
      maxMs: 1_000,
    }),
    1_000,
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

test("tmux mux backend resizes detached TUI windows to the requested surface", async (t) => {
  const backend = new TmuxMuxBackend();
  if (await skipIfTmuxUnavailable(t, backend)) {
    return;
  }

  const sessionName = createShortTmuxSessionName("rt");
  try {
    const created = await backend.createSession({
      sessionName,
      cwd: process.cwd(),
      title: "rah-tmux-resize",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('RESIZE_READY\\n'); setInterval(() => undefined, 1000)",
      ],
    });

    await waitFor(async () =>
      (await backend.dumpScreen(sessionName, created.paneId, { full: true })).includes(
        "RESIZE_READY",
      ),
    );

    await backend.resizePane?.(sessionName, created.paneId, 132, 43);
    await waitFor(async () => {
      const pane = (await backend.listPanes(sessionName))
        .find((candidate) => candidate.paneId === created.paneId);
      return Boolean(pane && pane.columns >= 130 && pane.rows >= 43);
    });
  } finally {
    await backend.killSession(sessionName).catch(() => undefined);
  }
});

test("tmux mux backend preserves failed pane output in full scrollback", async (t) => {
  const backend = new TmuxMuxBackend();
  if (await skipIfTmuxUnavailable(t, backend)) {
    return;
  }
  const sessionName = `rah-tmux-dead-pane-${process.pid}-${Date.now()}`;
  const created = await backend.createSession({
    sessionName,
    cwd: process.cwd(),
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('Error: unsupported model fixture\\n'); setTimeout(() => process.exit(1), 50);",
    ],
  });
  try {
    await waitFor(async () => {
      const pane = (await backend.listPanes(sessionName)).find(
        (candidate) => candidate.paneId === created.paneId,
      );
      return pane?.exited === true;
    });
    assert.match(
      await backend.dumpScreen(sessionName, created.paneId, { full: true }),
      /unsupported model fixture/,
    );
  } finally {
    await backend.killSession(sessionName);
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
          "process.stdout.write('\\u001b[?2004hRAW_READY\\n')",
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

    await backend.pasteText(sessionName, created.paneId, "pasted 中");
    await waitFor(async () => {
      const dumped = await backend.dumpScreen(sessionName, created.paneId, { full: true });
      return (
        /RAW_HEX:.*1b 5b 32 30 30 7e/.test(dumped) &&
        /RAW_HEX:.*70 61 73 74 65 64 20 e4 b8 ad/.test(dumped) &&
        /RAW_HEX:.*1b 5b 32 30 31 7e/.test(dumped)
      );
    });

    await backend.writeBytes(sessionName, created.paneId, "\u0004");
    await waitForPaneExitedOrRemoved(backend, sessionName, created.paneId);
  } finally {
    await backend.killSession(sessionName).catch(() => undefined);
  }
});
