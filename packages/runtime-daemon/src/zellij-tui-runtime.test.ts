import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { RuntimeEngine } from "./runtime-engine";
import { ZellijMuxBackend } from "./zellij-mux-backend";

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
  throw new Error("Timed out waiting for zellij native TUI runtime condition.");
}

async function skipIfZellijUnavailable(t: TestContext): Promise<boolean> {
  try {
    await new ZellijMuxBackend().ensureAvailable();
    return false;
  } catch {
    t.skip("zellij is not available on this host");
    return true;
  }
}

test("zellij_tui backend starts Codex, routes input, interrupts, and observes exit", async (t) => {
  if (await skipIfZellijUnavailable(t)) {
    return;
  }

  const engine = new RuntimeEngine();
  const workspace = mkdtempSync(path.join(os.tmpdir(), "rah-zellij-codex-"));
  const fakeCodex = path.join(workspace, "fake-codex.js");
  const providerSessionId = "019e0aaa-1111-7222-8333-abcdef123456";
  const previousCodexBinary = process.env.RAH_CODEX_BINARY;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(workspace, "codex-home");
  mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      "process.stdout.write(`ZELLIJ_CODEX_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
      `process.stdout.write('Session: ${providerSessionId}\\r\\n');`,
      "process.stdin.setEncoding('utf8');",
      "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
      "process.stdin.resume();",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  if (chunk.includes('\\u001b')) {",
      "    process.stdout.write('ZELLIJ_CODEX_INTERRUPTED\\r\\n›\\r\\n');",
      "    chunk = chunk.replace(/\\u001b/g, '');",
      "  }",
      "  buffer += chunk;",
      "  const parts = buffer.split(/\\r|\\n/);",
      "  buffer = parts.pop() ?? '';",
      "  for (const part of parts) {",
      "    if (!part.trim()) continue;",
      "    process.stdout.write(`ZELLIJ_CODEX_INPUT:${part.trim()}\\r\\n`);",
      "    if (part.trim() === 'exit') process.exit(0);",
      "  }",
      "});",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(fakeCodex, 0o755);
  process.env.RAH_CODEX_BINARY = fakeCodex;

  try {
    const started = await engine.startSession({
      provider: "codex",
      cwd: workspace,
      liveBackend: "zellij_tui",
      attach: {
        client: {
          id: "web-zellij",
          kind: "web",
          connectionId: "web-zellij",
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    const sessionId = started.session.session.id;
    assert.equal(started.session.session.liveBackend, "zellij_tui");
    assert.equal(started.session.session.mux?.backend, "zellij");
    assert.match(started.session.session.mux?.sessionName ?? "", /^rah-[0-9a-f]{8}$/);

    let transcript = "";
    const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
      if (frame.type === "pty.replay") {
        transcript += frame.chunks.join("");
      } else if (frame.type === "pty.output") {
        transcript += frame.data;
      }
    });

    await waitFor(() => {
      assert.match(transcript, /ZELLIJ_CODEX_READY/);
      assert.match(transcript, /--no-alt-screen/);
      assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
    });

    engine.sendInput(sessionId, { clientId: "web-zellij", text: "hello zellij codex" });
    await waitFor(() => {
      assert.match(transcript, /ZELLIJ_CODEX_INPUT:hello zellij codex/);
    });

    engine.interruptSession(sessionId, { clientId: "web-zellij" });
    await waitFor(() => {
      assert.match(transcript, /ZELLIJ_CODEX_INTERRUPTED/);
    });

    engine.sendInput(sessionId, { clientId: "web-zellij", text: "exit" });
    await waitFor(() => {
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "stopped");
      assert.equal(engine.getSessionSummary(sessionId).session.capabilities.steerInput, false);
    });

    unsubscribe();
    await engine.closeSession(sessionId, { clientId: "web-zellij" }).catch(() => undefined);
  } finally {
    await engine.shutdown();
    if (previousCodexBinary === undefined) {
      delete process.env.RAH_CODEX_BINARY;
    } else {
      process.env.RAH_CODEX_BINARY = previousCodexBinary;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(workspace, { force: true, recursive: true });
  }
});
