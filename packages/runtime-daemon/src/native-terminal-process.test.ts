import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NativeTerminalProcess } from "./native-terminal-process";

async function waitUntilProcessGone(pid: number, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(25);
  }
  throw new Error(`Process ${pid} was still alive`);
}

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

test("close resolves when the native process exits from the first signal", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-native-terminal-"));
  const scriptPath = path.join(tmpDir, "exit-on-term.js");
  writeFileSync(scriptPath, "setInterval(() => {}, 1000);");

  let exitSignal: string | undefined;
  const terminal = new NativeTerminalProcess({
    cwd: tmpDir,
    command: process.execPath,
    args: [scriptPath],
    closeTimeoutMs: 1_000,
    onExit: ({ signal }) => {
      exitSignal = signal;
    },
  });

  await delay(100);
  await Promise.race([
    terminal.close("SIGTERM"),
    delay(2_000).then(() => {
      throw new Error("Native terminal close timed out");
    }),
  ]);

  assert.equal(exitSignal, "SIGTERM");
});

test("close cleans up scanned child tree when root exits during scan", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rah-native-terminal-"));
  const childPidPath = path.join(tmpDir, "child.pid");
  const childScriptPath = path.join(tmpDir, "child.js");
  const rootScriptPath = path.join(tmpDir, "root.js");
  writeFileSync(childScriptPath, "setInterval(() => {}, 1000);");
  writeFileSync(
    rootScriptPath,
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const child = spawn(process.execPath, [${JSON.stringify(childScriptPath)}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  const terminal = new NativeTerminalProcess({
    cwd: tmpDir,
    command: process.execPath,
    args: [rootScriptPath],
    closeTimeoutMs: 1_000,
    onExit: () => undefined,
  });

  const started = Date.now();
  while (Date.now() - started < 2_000) {
    try {
      if (Number.isInteger(Number(readFileSync(childPidPath, "utf8")))) {
        break;
      }
    } catch {
      await delay(25);
    }
  }
  const childPid = Number(readFileSync(childPidPath, "utf8"));
  const rootPid = (terminal as unknown as { child: { pid: number } }).child.pid;
  (terminal as unknown as { childTreePids: () => Promise<number[]> }).childTreePids =
    async () => {
      await delay(50);
      return [childPid];
    };
  setTimeout(() => {
    process.kill(rootPid, "SIGTERM");
  }, 10);

  await terminal.close("SIGTERM");
  await waitUntilProcessGone(childPid);
});
