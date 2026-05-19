import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderKind } from "@rah/runtime-protocol";
import {
  buildNativeTuiSessionCapabilities,
  buildStoppedNativeTuiSessionCapabilities,
} from "./runtime-terminal-capabilities";
import { nativeTuiInterruptDataForProvider } from "./runtime-terminal-coordinator";

describe("runtime terminal capabilities", () => {
  test("native TUI sessions expose terminal-first capabilities for core running providers", () => {
    const providers: ProviderKind[] = ["codex", "claude", "gemini", "opencode"];

    for (const provider of providers) {
      const capabilities = buildNativeTuiSessionCapabilities(provider);
      assert.equal(capabilities.nativeTui, true);
      assert.equal(capabilities.rawPtyInput, true);
      assert.equal(capabilities.chatMirror, true);
      assert.equal(capabilities.structuredTimeline, true);
      assert.equal(capabilities.structuredControl, false);
      assert.equal(capabilities.livePermissions, false);
      assert.equal(capabilities.modelSwitch, false);
      assert.equal(capabilities.planMode, false);
      assert.equal(capabilities.actions?.stop, true);
      assert.equal(capabilities.actions?.rename, "none");
    }
  });

  test("native TUI custom providers degrade to TUI without structured mirror", () => {
    const capabilities = buildNativeTuiSessionCapabilities("custom");
    assert.equal(capabilities.nativeTui, true);
    assert.equal(capabilities.rawPtyInput, true);
    assert.equal(capabilities.chatMirror, false);
    assert.equal(capabilities.structuredTimeline, false);
    assert.equal(capabilities.structuredControl, false);
  });

  test("stopped native TUI sessions keep history actions but lose live input surfaces", () => {
    const capabilities = buildStoppedNativeTuiSessionCapabilities("codex");
    assert.equal(capabilities.nativeTui, true);
    assert.equal(capabilities.liveAttach, false);
    assert.equal(capabilities.rawPtyInput, false);
    assert.equal(capabilities.chatMirror, false);
    assert.equal(capabilities.steerInput, false);
    assert.equal(capabilities.queuedInput, false);
    assert.equal(capabilities.actions?.stop, true);
    assert.equal(capabilities.actions?.info, true);
  });

  test("native TUI interrupt keys follow provider-native stop semantics", () => {
    assert.equal(nativeTuiInterruptDataForProvider("codex"), "\u001b");
    assert.equal(nativeTuiInterruptDataForProvider("claude"), "\u001b");
    assert.equal(nativeTuiInterruptDataForProvider("gemini"), "\u001b");
    assert.equal(nativeTuiInterruptDataForProvider("opencode"), "\u001b\u001b");
  });
});
