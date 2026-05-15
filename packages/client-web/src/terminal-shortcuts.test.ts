import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_TUI_SHORTCUTS } from "./terminal-shortcuts";

test("terminal shortcut bar exposes core TUI control keys", () => {
  const byLabel = new Map(TERMINAL_TUI_SHORTCUTS.map((shortcut) => [shortcut.label, shortcut]));

  assert.equal(byLabel.get("Esc")?.data, "\u001b");
  assert.equal(byLabel.get("Ctrl-C")?.data, "\u0003");
  assert.equal(byLabel.get("Ctrl-D")?.data, "\u0004");
  assert.equal(byLabel.get("Ctrl-Z")?.data, "\u001a");
  assert.equal(byLabel.get("Tab")?.data, "\t");
  assert.equal(byLabel.get("Enter")?.data, "\r");
  assert.equal(byLabel.get("↑")?.data, "\u001b[A");
  assert.equal(byLabel.get("↓")?.data, "\u001b[B");
  assert.equal(byLabel.get("←")?.data, "\u001b[D");
  assert.equal(byLabel.get("→")?.data, "\u001b[C");
});
