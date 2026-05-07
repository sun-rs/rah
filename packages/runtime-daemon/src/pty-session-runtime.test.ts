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
