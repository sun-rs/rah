import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { PtySessionRuntime, type PtySessionRuntimeExitArgs } from "./pty-session-runtime";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for PTY session runtime condition.");
}

test("starts, controls, and closes a daemon-owned PTY session", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-pty-runtime-"));
  const scriptPath = path.join(tmpDir, "hold-open.js");
  writeFileSync(
    scriptPath,
    [
      "console.log('rah-pty-ready');",
      "process.stdin.resume();",
    ].join("\n"),
  );

  const runtime = new PtySessionRuntime();
  const output: string[] = [];
  let exitArgs: PtySessionRuntimeExitArgs | undefined;

  const terminal = await runtime.start({
    id: "pty-test",
    cwd: tmpDir,
    command: process.execPath,
    args: [scriptPath],
    cols: 80,
    rows: 20,
    onData: (id, data) => {
      assert.equal(id, "pty-test");
      output.push(data);
    },
    onExit: (id, args) => {
      assert.equal(id, "pty-test");
      exitArgs = args;
    },
  });

  assert.equal(terminal.id, "pty-test");
  assert.equal(terminal.cwd, tmpDir);
  assert.equal(runtime.has("pty-test"), true);
  await waitFor(() => output.join("").includes("rah-pty-ready"));

  assert.equal(runtime.write("pty-test", "ignored input\n"), true);
  assert.equal(runtime.resize("pty-test", 100, 32), true);

  assert.equal(await runtime.close("pty-test"), true);
  await waitFor(() => exitArgs !== undefined);
  assert.equal(runtime.has("pty-test"), false);
  assert.equal(runtime.write("pty-test", "after close"), false);
  assert.equal(runtime.resize("pty-test", 80, 24), false);
});

test("preserves UTF-8 output split across PTY chunks", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-pty-utf8-"));
  const scriptPath = path.join(tmpDir, "split-utf8.js");
  writeFileSync(
    scriptPath,
    [
      "const bytes = Buffer.from('你');",
      "process.stdout.write(bytes.subarray(0, 1));",
      "setTimeout(() => process.stdout.write(bytes.subarray(1)), 25);",
      "setTimeout(() => process.stdout.write('\\nrah-utf8-done\\n'), 50);",
      "process.stdin.resume();",
    ].join("\n"),
  );

  const runtime = new PtySessionRuntime();
  const output: string[] = [];
  const terminal = await runtime.start({
    id: "pty-utf8-test",
    cwd: tmpDir,
    command: process.execPath,
    args: [scriptPath],
    cols: 80,
    rows: 20,
    onData: (_id, data) => output.push(data),
    onExit: () => undefined,
  });

  assert.equal(terminal.id, "pty-utf8-test");
  await waitFor(() => output.join("").includes("rah-utf8-done"));
  assert.match(output.join(""), /你/);
  assert.doesNotMatch(output.join(""), /\uFFFD/);

  await runtime.close("pty-utf8-test");
});

test("normalizes daemon-owned PTY terminal environment", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-pty-env-"));
  const scriptPath = path.join(tmpDir, "env.js");
  writeFileSync(
    scriptPath,
    [
      "process.stdout.write('RAH_ENV:' + JSON.stringify({",
      "  TERM: process.env.TERM,",
      "  COLORTERM: process.env.COLORTERM,",
      "  CLICOLOR: process.env.CLICOLOR,",
      "  FORCE_COLOR: process.env.FORCE_COLOR,",
      "  NO_COLOR: process.env.NO_COLOR ?? null,",
      "  TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,",
      "  ITERM_SESSION_ID: process.env.ITERM_SESSION_ID ?? null,",
      "  CODEX_CI: process.env.CODEX_CI ?? null,",
      "  CODEX_THREAD_ID: process.env.CODEX_THREAD_ID ?? null,",
      "  CODEX_HOME: process.env.CODEX_HOME ?? null,",
      "}) + '\\n');",
      "process.stdin.resume();",
    ].join("\n"),
  );

  const runtime = new PtySessionRuntime();
  const output: string[] = [];
  await runtime.start({
    id: "pty-env-test",
    cwd: tmpDir,
    command: process.execPath,
    args: [scriptPath],
    cols: 88,
    rows: 24,
    env: {
      ITERM_SESSION_ID: "fake-iterm-session",
      NO_COLOR: "1",
      TERM: "dumb",
      TERM_PROGRAM: "iTerm.app",
      CODEX_CI: "1",
      CODEX_THREAD_ID: "parent-codex-thread",
      CODEX_HOME: "/tmp/rah-codex-home",
    },
    onData: (_id, data) => output.push(data),
    onExit: () => undefined,
  });

  await waitFor(() => output.join("").includes("RAH_ENV:"));
  const match = /RAH_ENV:(\{.*\})/.exec(output.join(""));
  assert.ok(match);
  const parsed = JSON.parse(match[1]!);
  assert.deepEqual(parsed, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLICOLOR: "1",
    FORCE_COLOR: "1",
    NO_COLOR: null,
    TERM_PROGRAM: null,
    ITERM_SESSION_ID: null,
    CODEX_CI: null,
    CODEX_THREAD_ID: null,
    CODEX_HOME: "/tmp/rah-codex-home",
  });

  await runtime.close("pty-env-test");
});
