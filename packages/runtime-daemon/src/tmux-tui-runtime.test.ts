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

function writeFakeGeminiBinary(filePath: string): void {
  writeFileSync(
    filePath,
    [
      "#!/usr/bin/env node",
      "process.stdout.write('TMUX_GEMINI_BOOTING\\r\\n');",
      "process.stdin.setEncoding('utf8');",
      "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
      "process.stdin.resume();",
      "let buffer = '';",
      "setTimeout(() => process.stdout.write('TMUX_GEMINI_READY\\r\\n>   Type your message or @path/to/file\\r\\n'), 600);",
      "process.stdin.on('data', (chunk) => {",
      "  if (chunk.includes('\\u001b')) {",
      "    chunk = chunk.replace(/\\u001b/g, '');",
      "    process.stdout.write('TMUX_GEMINI_INTERRUPTED\\r\\n>   Type your message or @path/to/file\\r\\n');",
      "  }",
      "  buffer += chunk;",
      "  const parts = buffer.split(/\\r|\\n/);",
      "  buffer = parts.pop() ?? '';",
      "  for (const part of parts) {",
      "    if (!part.trim()) continue;",
      "    process.stdout.write(`TMUX_GEMINI_INPUT:${part.trim()}\\r\\n>   Type your message or @path/to/file\\r\\n`);",
      "  }",
      "});",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(filePath, 0o755);
}

function writeFailingTuiBinary(filePath: string, message: string): void {
  writeFileSync(
    filePath,
    [
      "#!/usr/bin/env node",
      `process.stdout.write(${JSON.stringify(`${message}\r\n`)});`,
      "setTimeout(() => process.exit(1), 900);",
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

test("tui_mux fallback uses tmux as the managed mux backend", async (t) => {
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
      liveBackend: "tui_mux",
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

test("Gemini tui_mux queues Web input until the prompt is visible", async (t) => {
  if (await skipIfTmuxUnavailable(t)) {
    return;
  }
  const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-tmux-gemini-"));
  const fakeGemini = path.join(workspace, "fake-gemini.js");
  writeFakeGeminiBinary(fakeGemini);
  const restoreRahHome = setEnv("RAH_HOME", path.join(workspace, "rah-home"));
  const restoreMux = setEnv("RAH_TUI_MUX", "tmux");
  const restoreGemini = setEnv("RAH_GEMINI_BINARY", fakeGemini);
  const engine = new RuntimeEngine();
  try {
    const started = await engine.startSession({
      provider: "gemini",
      cwd: workspace,
      liveBackend: "tui_mux",
      attach: {
        client: {
          id: "web-tmux-gemini",
          kind: "web",
          connectionId: "web-tmux-gemini",
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    const sessionId = started.session.session.id;
    assert.equal(started.session.session.nativeTui?.promptState, "agent_busy");
    let transcript = "";
    const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
      if (frame.type === "pty.replay") {
        transcript += frame.chunks.join("");
      } else if (frame.type === "pty.output") {
        transcript += frame.data;
      }
    });
    try {
      engine.sendInput(sessionId, {
        clientId: "web-tmux-gemini",
        text: "first gemini prompt",
      });
      await waitFor(() => {
        assert.equal(engine.getSessionSummary(sessionId).session.nativeTui?.queuedInputCount, 1);
      });
      await delay(250);
      assert.doesNotMatch(transcript, /TMUX_GEMINI_INPUT:first gemini prompt/);

      await waitFor(() => {
        assert.match(transcript, /TMUX_GEMINI_READY/);
        assert.match(transcript, /TMUX_GEMINI_INPUT:first gemini prompt/);
        assert.ok(
          transcript.indexOf("TMUX_GEMINI_INPUT:first gemini prompt") >
            transcript.indexOf("TMUX_GEMINI_READY"),
        );
      });

      engine.interruptSession(sessionId, { clientId: "web-tmux-gemini" });
      await waitFor(() => {
        assert.match(transcript, /TMUX_GEMINI_INTERRUPTED/);
        assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "idle");
      });
    } finally {
      unsubscribe();
    }
    await engine.closeSession(sessionId, { clientId: "web-tmux-gemini" });
  } finally {
    await engine.shutdown();
    restoreGemini();
    restoreMux();
    restoreRahHome();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("tui_mux startup failures keep the provider error on a failed session", async (t) => {
  if (await skipIfTmuxUnavailable(t)) {
    return;
  }
  const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-tmux-failing-gemini-"));
  const fakeGemini = path.join(workspace, "fake-gemini-failing.js");
  writeFailingTuiBinary(fakeGemini, "Error: unsupported model gemini-wrong-model");
  const restoreRahHome = setEnv("RAH_HOME", path.join(workspace, "rah-home"));
  const restoreMux = setEnv("RAH_TUI_MUX", "tmux");
  const restoreGemini = setEnv("RAH_GEMINI_BINARY", fakeGemini);
  const engine = new RuntimeEngine();
  try {
    const started = await engine.startSession({
      provider: "gemini",
      cwd: workspace,
      liveBackend: "tui_mux",
      model: "gemini-wrong-model",
      attach: {
        client: {
          id: "web-tmux-failing-gemini",
          kind: "web",
          connectionId: "web-tmux-failing-gemini",
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    const sessionId = started.session.session.id;
    const muxSessionName = started.session.session.mux?.sessionName;
    assert.ok(muxSessionName);

    await waitFor(() => {
      const summary = engine.getSessionSummary(sessionId).session;
      assert.equal(summary.runtimeState, "failed");
      assert.equal(summary.status, "stopped");
      assert.equal(summary.phase, "failed");
      assert.match(
        summary.runtimeDiagnostics?.lastError ?? "",
        /unsupported model gemini-wrong-model/,
      );
    }, 7_000);
    await waitFor(async () => {
      await assertTmuxSessionGone(muxSessionName);
    });
    await engine.closeSession(sessionId, { clientId: "web-tmux-failing-gemini" });
  } finally {
    await engine.shutdown();
    restoreGemini();
    restoreMux();
    restoreRahHome();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("Council can stop a Claude tui_mux agent without leaving tmux behind", async (t) => {
  if (await skipIfTmuxUnavailable(t)) {
    return;
  }
  const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-tmux-council-claude-"));
  const fakeClaude = path.join(workspace, "fake-claude.js");
  writeFakeClaudeBinary(fakeClaude);
  const restoreRahHome = setEnv("RAH_HOME", path.join(workspace, "rah-home"));
  const restoreMux = setEnv("RAH_TUI_MUX", "tmux");
  const restoreClaude = setEnv("RAH_CLAUDE_BINARY", fakeClaude);
  const engine = new RuntimeEngine();
  try {
    const created = await engine.createCouncil({
      workspace,
      agents: [{ id: "claude-reviewer", provider: "claude", label: "Claude Reviewer" }],
    });
    const councilId = created.council.id;
    const agentId = created.council.agents[0]!.id;
    let sessionId = "";
    await waitFor(() => {
      const council = engine.listCouncils().councils.find((candidate) => candidate.id === councilId);
      assert.ok(council);
      sessionId = council.agents[0]?.nativeSessionId ?? "";
      assert.ok(sessionId);
      const state = engine.sessionStore.getSession(sessionId);
      assert.ok(state);
      assert.equal(state.session.liveBackend, "tui_mux");
      assert.ok(state.session.mux?.sessionName);
    });
    const muxSessionName = engine.sessionStore.getSession(sessionId)?.session.mux?.sessionName;
    assert.ok(muxSessionName);

    await engine.stopCouncilAgent(councilId, agentId);

    assert.equal(engine.sessionStore.getSession(sessionId), undefined);
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
