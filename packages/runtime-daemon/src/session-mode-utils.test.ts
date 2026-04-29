import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeModeState,
  buildCodexModeState,
  buildGeminiModeState,
  buildKimiModeState,
  buildOpenCodeModeState,
  providerModeDescriptors,
} from "./session-mode-utils";

test("provider mode descriptors use canonical access labels", () => {
  assert.deepEqual(accessLabels(buildCodexModeState({
    currentModeId: "never/danger-full-access",
    mutable: true,
    planAvailable: true,
  })), {
    "on-request/read-only": "Ask",
    "on-request/workspace-write": "Auto edit",
    "never/workspace-write": "Full auto · sandboxed",
    "never/danger-full-access": "Full auto",
  });
  assert.deepEqual(accessLabels(buildClaudeModeState({
    currentModeId: "bypassPermissions",
    mutable: true,
  })), {
    default: "Ask",
    acceptEdits: "Auto edit",
    bypassPermissions: "Full auto",
  });
  assert.deepEqual(accessLabels(buildGeminiModeState({
    currentModeId: "yolo",
    mutable: true,
  })), {
    default: "Ask",
    auto_edit: "Auto edit",
    yolo: "Full auto",
  });
  assert.deepEqual(accessLabels(buildKimiModeState({
    currentModeId: "yolo",
    mutable: true,
  })), {
    default: "Ask",
    yolo: "Full auto",
  });
  assert.deepEqual(accessLabels(buildOpenCodeModeState({
    currentModeId: "opencode/full-auto",
    mutable: true,
  })), {
    build: "Ask",
    "opencode/full-auto": "Full auto",
  });
});

test("provider mode descriptors expose stable UI roles", () => {
  assert.deepEqual(accessRoles(buildCodexModeState({
    currentModeId: "never/danger-full-access",
    mutable: true,
    planAvailable: true,
  })), {
    "on-request/read-only": "ask",
    "on-request/workspace-write": "auto_edit",
    "never/workspace-write": "full_auto",
    "never/danger-full-access": "full_auto",
  });
  assert.equal(
    buildCodexModeState({
      currentModeId: "never/danger-full-access",
      mutable: true,
      planAvailable: true,
    }).availableModes.find((mode) => mode.id === "plan")?.role,
    "plan",
  );
});

test("provider mode descriptors expose adapter-owned apply timing", () => {
  assert.deepEqual(applyTimings("codex"), {
    "on-request/read-only": "next_turn",
    plan: "next_turn",
    "on-request/workspace-write": "next_turn",
    "never/workspace-write": "next_turn",
    "never/danger-full-access": "next_turn",
  });
  assert.deepEqual(applyTimings("claude"), {
    default: "immediate",
    acceptEdits: "immediate",
    plan: "immediate",
    bypassPermissions: "immediate",
  });
  assert.deepEqual(applyTimings("gemini"), {
    default: "next_turn",
    auto_edit: "next_turn",
    plan: "next_turn",
    yolo: "next_turn",
  });
  assert.deepEqual(applyTimings("kimi"), {
    default: "idle_only",
    plan: "idle_only",
    yolo: "idle_only",
  });
  assert.deepEqual(applyTimings("opencode"), {
    build: "next_turn",
    "opencode/full-auto": "next_turn",
    plan: "next_turn",
  });
});

function accessLabels(state: ReturnType<typeof buildCodexModeState>): Record<string, string> {
  return Object.fromEntries(
    state.availableModes
      .filter((mode) => mode.id !== "plan")
      .map((mode) => [mode.id, mode.label]),
  );
}

function accessRoles(state: ReturnType<typeof buildCodexModeState>): Record<string, string | undefined> {
  return Object.fromEntries(
    state.availableModes
      .filter((mode) => mode.id !== "plan")
      .map((mode) => [mode.id, mode.role]),
  );
}

function applyTimings(provider: Parameters<typeof providerModeDescriptors>[0]): Record<string, string | undefined> {
  return Object.fromEntries(
    providerModeDescriptors(provider).map((mode) => [mode.id, mode.applyTiming]),
  );
}
