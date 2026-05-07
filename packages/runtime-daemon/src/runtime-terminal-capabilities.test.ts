import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderKind } from "@rah/runtime-protocol";
import {
  buildNativeTuiSessionCapabilities,
  buildTerminalWrapperSessionCapabilities,
} from "./runtime-terminal-capabilities";

describe("runtime terminal capabilities", () => {
  test("native TUI sessions expose terminal-first capabilities for built-in providers", () => {
    const providers: ProviderKind[] = ["codex", "claude", "gemini", "kimi", "opencode"];

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
      assert.equal(capabilities.actions?.archive, true);
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

  test("terminal wrapper permissions match provider support boundaries", () => {
    assert.equal(buildTerminalWrapperSessionCapabilities("codex").livePermissions, true);
    assert.equal(buildTerminalWrapperSessionCapabilities("kimi").livePermissions, true);
    assert.equal(buildTerminalWrapperSessionCapabilities("opencode").livePermissions, true);
    assert.equal(buildTerminalWrapperSessionCapabilities("claude").livePermissions, false);
    assert.equal(buildTerminalWrapperSessionCapabilities("gemini").livePermissions, false);
  });

  test("terminal wrapper sessions remain external-control surfaces", () => {
    const capabilities = buildTerminalWrapperSessionCapabilities("codex");
    assert.equal(capabilities.steerInput, true);
    assert.equal(capabilities.queuedInput, true);
    assert.equal(capabilities.renameSession, false);
    assert.equal(capabilities.actions?.archive, true);
    assert.equal(capabilities.actions?.delete, false);
  });
});
