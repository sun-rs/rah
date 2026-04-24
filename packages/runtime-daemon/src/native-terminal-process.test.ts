import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NativeTerminalProcess } from "./native-terminal-process";

test("close escalates when a native TUI ignores the first signal", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-native-terminal-"));
  const scriptPath = path.join(tmpDir, "ignore-term.js");
  writeFileSync(
    scriptPath,
    [
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  let exitSignal: string | undefined;
  const terminal = new NativeTerminalProcess({
    cwd: tmpDir,
    command: process.execPath,
    args: [scriptPath],
    closeTimeoutMs: 50,
    onExit: ({ signal }) => {
      exitSignal = signal;
    },
  });

  await delay(100);
  await terminal.close("SIGTERM");

  assert.equal(exitSignal, "SIGKILL");
});
