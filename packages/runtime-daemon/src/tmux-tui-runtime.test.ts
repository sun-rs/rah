import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { RuntimeEngine } from "./runtime-engine";
import { createTmuxSessionNameForRahSession, TmuxMuxBackend } from "./tmux-mux-backend";

async function waitFor(predicate: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await predicate();
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Timed out waiting for tmux native TUI runtime condition.");
}

async function skipIfTmuxUnavailable(t: TestContext): Promise<boolean> {
  try {
    await new TmuxMuxBackend().ensureAvailable();
    return false;
  } catch {
    t.skip("tmux is not available on this host");
    return true;
  }
}

function setEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

function writeFakeClaudeBinary(filePath: string): void {
  writeFileSync(
    filePath,
    [
      "#!/usr/bin/env node",
      "process.stdout.write('TMUX_CLAUDE_READY\\r\\n›\\r\\n');",
      "process.stdin.setEncoding('utf8');",
      "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
      "process.stdin.resume();",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  if (chunk.includes('\\u001b')) {",
      "    chunk = chunk.replace(/\\u001b/g, '');",
      "    process.stdout.write('TMUX_CLAUDE_INTERRUPTED\\r\\n›\\r\\n');",
      "  }",
      "  if (chunk.includes('\\u0015') || chunk.includes('\\u000b')) {",
      "    chunk = chunk.slice(Math.max(chunk.lastIndexOf('\\u0015'), chunk.lastIndexOf('\\u000b')) + 1);",
      "    buffer = '';",
      "    process.stdout.write('TMUX_CLAUDE_CLEARED\\r\\n');",
      "  }",
      "  buffer += chunk;",
      "  const parts = buffer.split(/\\r|\\n/);",
      "  buffer = parts.pop() ?? '';",
      "  for (const part of parts) {",
      "    if (!part.trim()) continue;",
      "    process.stdout.write(`TMUX_CLAUDE_INPUT:${part.trim()}\\r\\n›\\r\\n`);",
      "    if (part.trim() === 'exit') process.exit(0);",
      "  }",
      "});",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(filePath, 0o755);
}

async function assertTmuxSessionGone(sessionName: string): Promise<void> {
  const sessions = await new TmuxMuxBackend().listSessions();
  assert.equal(
    sessions.some((session) => session.sessionName === sessionName),
    false,
  );
}

test("zellij_tui fallback can use tmux as the managed mux backend", async (t) => {
  if (await skipIfTmuxUnavailable(t)) {
    return;
  }
  const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-tmux-claude-"));
  const fakeClaude = path.join(workspace, "fake-claude.js");
  writeFakeClaudeBinary(fakeClaude);
  const restoreRahHome = setEnv("RAH_HOME", path.join(workspace, "rah-home"));
  const restoreMux = setEnv("RAH_TUI_MUX", "tmux");
  const restoreClaude = setEnv("RAH_CLAUDE_BINARY", fakeClaude);
  const engine = new RuntimeEngine();
  try {
    const started = await engine.startSession({
      provider: "claude",
      cwd: workspace,
      liveBackend: "zellij_tui",
      attach: {
        client: {
          id: "web-tmux-claude",
          kind: "web",
          connectionId: "web-tmux-claude",
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    const sessionId = started.session.session.id;
    assert.equal(started.session.session.mux?.backend, "tmux");
    assert.equal(
      started.session.session.mux?.sessionName,
      createTmuxSessionNameForRahSession(sessionId),
    );
    assert.match(started.session.session.mux?.paneId ?? "", /^%\d+$/);

    let transcript = "";
    const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
      if (frame.type === "pty.replay") {
        transcript += frame.chunks.join("");
      } else if (frame.type === "pty.output") {
        transcript += frame.data;
      }
    });
    try {
      await waitFor(() => {
        assert.match(transcript, /TMUX_CLAUDE_READY/);
      });
      engine.sendInput(sessionId, {
        clientId: "web-tmux-claude",
        text: "hello through tmux",
      });
      await waitFor(() => {
        assert.match(transcript, /TMUX_CLAUDE_INPUT:hello through tmux/);
      });
      engine.interruptSession(sessionId, { clientId: "web-tmux-claude" });
      await waitFor(() => {
        assert.match(transcript, /TMUX_CLAUDE_INTERRUPTED/);
      });
    } finally {
      unsubscribe();
    }

    const muxSessionName = started.session.session.mux?.sessionName;
    assert.ok(muxSessionName);
    await engine.closeSession(sessionId, { clientId: "web-tmux-claude" });
    await waitFor(async () => {
      await assertTmuxSessionGone(muxSessionName);
    });
  } finally {
    await engine.shutdown();
    restoreClaude();
    restoreMux();
    restoreRahHome();
    rmSync(workspace, { force: true, recursive: true });
  }
});
