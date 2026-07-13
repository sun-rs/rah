import assert from "node:assert/strict";
import test from "node:test";
import { isMeaningfulTerminalOutput } from "./terminal-startup-output";

test("ignores terminal control sequences and RAH startup notices", () => {
  assert.equal(isMeaningfulTerminalOutput("\u001b[2J\u001b[H"), false);
  assert.equal(isMeaningfulTerminalOutput("[rah] Starting Codex native TUI...\r\n"), false);
});

test("recognizes replay content that follows a RAH startup notice", () => {
  assert.equal(
    isMeaningfulTerminalOutput(
      "[rah] Starting Codex native TUI...\r\n\u001b[2J\u001b[HOpenAI Codex\r\n› prompt",
    ),
    true,
  );
});

test("recognizes ordinary terminal output", () => {
  assert.equal(isMeaningfulTerminalOutput("\u001b[32mReady\u001b[0m"), true);
});
