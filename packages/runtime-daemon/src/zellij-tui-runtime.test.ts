import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderKind } from "@rah/runtime-protocol";

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

function writeFakeTuiBinary(filePath: string, provider: ProviderKind, options: {
  providerSessionId?: string;
} = {}): void {
  writeFileSync(
    filePath,
    [
      "#!/usr/bin/env node",
      `const provider = ${JSON.stringify(provider)};`,
      "process.stdout.write(`ZELLIJ_${provider.toUpperCase()}_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
      ...(options.providerSessionId
        ? [`process.stdout.write(${JSON.stringify(`Session: ${options.providerSessionId}\r\n`)});`]
        : []),
      "process.stdin.setEncoding('utf8');",
      "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
      "process.stdin.resume();",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  if (chunk.includes('\\u001b')) {",
      "    process.stdout.write(`ZELLIJ_${provider.toUpperCase()}_INTERRUPTED\\r\\n›\\r\\n`);",
      "    chunk = chunk.replace(/\\u001b/g, '');",
      "  }",
      "  buffer += chunk;",
      "  const parts = buffer.split(/\\r|\\n/);",
      "  buffer = parts.pop() ?? '';",
      "  for (const part of parts) {",
      "    if (!part.trim()) continue;",
      "    process.stdout.write(`ZELLIJ_${provider.toUpperCase()}_INPUT:${part.trim()}\\r\\n`);",
      "    if (part.trim() === 'exit') process.exit(0);",
      "  }",
      "});",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(filePath, 0o755);
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

async function startZellijProviderSession(params: {
  provider: ProviderKind;
  envName: string;
  workspacePrefix: string;
  binaryName: string;
  fakeProviderSessionId?: string;
  assertReady?: (args: {
    transcript: string;
    sessionId: string;
    engine: RuntimeEngine;
  }) => void;
}): Promise<void> {
  const engine = new RuntimeEngine();
  const workspace = mkdtempSync(path.join(os.tmpdir(), params.workspacePrefix));
  const fakeBinary = path.join(workspace, params.binaryName);
  writeFakeTuiBinary(fakeBinary, params.provider, {
    ...(params.fakeProviderSessionId
      ? { providerSessionId: params.fakeProviderSessionId }
      : {}),
  });
  const restoreBinary = setEnv(params.envName, fakeBinary);
  const restoreCodexHome =
    params.provider === "codex"
      ? setEnv("CODEX_HOME", path.join(workspace, "codex-home"))
      : () => undefined;
  if (params.provider === "codex") {
    mkdirSync(path.join(process.env.CODEX_HOME ?? workspace, "sessions"), { recursive: true });
  }

  try {
    const started = await engine.startSession({
      provider: params.provider,
      cwd: workspace,
      liveBackend: "zellij_tui",
      attach: {
        client: {
          id: `web-zellij-${params.provider}`,
          kind: "web",
          connectionId: `web-zellij-${params.provider}`,
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    const sessionId = started.session.session.id;
    assert.equal(started.session.session.liveBackend, "zellij_tui");
    assert.equal(started.session.session.mux?.backend, "zellij");
    assert.match(started.session.session.mux?.sessionName ?? "", /^rah-[0-9a-f]{8}$/);
    assert.match(started.session.session.mux?.paneId ?? "", /^terminal_\d+$/);

    let transcript = "";
    const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
      if (frame.type === "pty.replay") {
        transcript += frame.chunks.join("");
      } else if (frame.type === "pty.output") {
        transcript += frame.data;
      }
    });

    await waitFor(() => {
      assert.match(transcript, new RegExp(`ZELLIJ_${params.provider.toUpperCase()}_READY`));
      params.assertReady?.({ transcript, sessionId, engine });
    });

    engine.sendInput(sessionId, {
      clientId: `web-zellij-${params.provider}`,
      text: `hello zellij ${params.provider}`,
    });
    await waitFor(() => {
      assert.match(
        transcript,
        new RegExp(`ZELLIJ_${params.provider.toUpperCase()}_INPUT:hello zellij ${params.provider}`),
      );
    });

    engine.interruptSession(sessionId, { clientId: `web-zellij-${params.provider}` });
    await waitFor(() => {
      assert.match(transcript, new RegExp(`ZELLIJ_${params.provider.toUpperCase()}_INTERRUPTED`));
    });

    engine.sendInput(sessionId, { clientId: `web-zellij-${params.provider}`, text: "exit" });
    await waitFor(() => {
      assert.equal(engine.getSessionSummary(sessionId).session.runtimeState, "stopped");
      assert.equal(engine.getSessionSummary(sessionId).session.capabilities.steerInput, false);
    });

    unsubscribe();
    await engine.closeSession(sessionId, { clientId: `web-zellij-${params.provider}` }).catch(
      () => undefined,
    );
  } finally {
    await engine.shutdown();
    restoreCodexHome();
    restoreBinary();
    rmSync(workspace, { force: true, recursive: true });
  }
}

test("zellij_tui backend starts Codex, routes input, interrupts, and observes exit", async (t) => {
  if (await skipIfZellijUnavailable(t)) {
    return;
  }
  const providerSessionId = "019e0aaa-1111-7222-8333-abcdef123456";
  await startZellijProviderSession({
    provider: "codex",
    envName: "RAH_CODEX_BINARY",
    workspacePrefix: "rah-zellij-codex-",
    binaryName: "fake-codex.js",
    fakeProviderSessionId: providerSessionId,
    assertReady: ({ transcript, sessionId, engine }) => {
      assert.match(transcript, /--no-alt-screen/);
      assert.equal(engine.getSessionSummary(sessionId).session.providerSessionId, providerSessionId);
    },
  });
});

test("zellij_tui backend starts Claude, routes input, interrupts, and observes exit", async (t) => {
  if (await skipIfZellijUnavailable(t)) {
    return;
  }
  await startZellijProviderSession({
    provider: "claude",
    envName: "RAH_CLAUDE_BINARY",
    workspacePrefix: "rah-zellij-claude-",
    binaryName: "fake-claude.js",
    assertReady: ({ sessionId, engine }) => {
      assert.match(
        engine.getSessionSummary(sessionId).session.providerSessionId ?? "",
        /^[0-9a-f-]{36}$/,
      );
    },
  });
});

test("zellij_tui backend starts OpenCode, routes input, interrupts, and observes exit", async (t) => {
  if (await skipIfZellijUnavailable(t)) {
    return;
  }
  await startZellijProviderSession({
    provider: "opencode",
    envName: "RAH_OPENCODE_BINARY",
    workspacePrefix: "rah-zellij-opencode-",
    binaryName: "fake-opencode.js",
  });
});
