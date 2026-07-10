import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeModeState,
  buildClaudeModeDescriptorsFromHelp,
  buildCodexModeState,
  buildOpenCodeAgentModeDescriptors,
  buildOpenCodeModeState,
  codexPlanAccessModeId,
  codexPlanModeId,
  isCodexModeId,
  parseCodexModeId,
  providerModeDescriptors,
} from "./session-mode-utils";

test("provider mode descriptors use provider-native labels", () => {
  assert.deepEqual(accessLabels(buildCodexModeState({
    currentModeId: "never/danger-full-access",
    mutable: true,
    planAvailable: true,
  })), {
    "on-request/workspace-write": "Default",
    "auto-review/workspace-write": "Auto Review",
    "never/danger-full-access": "Full Access",
  });
  assert.deepEqual(accessLabels(buildClaudeModeState({
    currentModeId: "bypassPermissions",
    mutable: true,
  })), {
    default: "Default",
    acceptEdits: "Accept Edits",
    bypassPermissions: "Bypass Permissions",
  });
  assert.deepEqual(allLabels(buildOpenCodeModeState({
    currentModeId: "build",
    mutable: true,
  })), {
    build: "Build",
    plan: "Plan",
  });
});

test("provider mode descriptors expose stable UI roles", () => {
  assert.deepEqual(accessRoles(buildCodexModeState({
    currentModeId: "never/danger-full-access",
    mutable: true,
    planAvailable: true,
  })), {
    "on-request/workspace-write": "ask",
    "auto-review/workspace-write": "auto_edit",
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
    "on-request/workspace-write": "startup_only",
    "auto-review/workspace-write": "startup_only",
    "never/danger-full-access": "startup_only",
  });
  assert.deepEqual(applyTimings("claude"), {
    default: "startup_only",
    acceptEdits: "startup_only",
    plan: "startup_only",
    bypassPermissions: "startup_only",
  });
  assert.deepEqual(applyTimings("opencode"), {
    build: "next_turn",
    plan: "next_turn",
  });
});

test("Claude permission-mode choices are parsed from help and hidden modes are omitted", () => {
  const modes = buildClaudeModeDescriptorsFromHelp(
    '--permission-mode <mode> Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")',
  );
  assert.deepEqual(modes.map((mode) => mode.id), [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
  ]);
});

test("OpenCode agent descriptors preserve dynamic custom agents", () => {
  const modes = buildOpenCodeAgentModeDescriptors([
    { id: "build", label: "Build" },
    { id: "sisyfus", label: "sisyfus", description: "Custom agent" },
  ]);
  assert.deepEqual(modes.map((mode) => [mode.id, mode.label]), [
    ["build", "Build"],
    ["sisyfus", "sisyfus"],
  ]);
});

test("Codex Auto Review mode maps to app-server approvalsReviewer", () => {
  assert.deepEqual(parseCodexModeId("auto-review/workspace-write"), {
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    approvalsReviewer: "auto_review",
  });
});

test("Codex plan mode id carries the selected access preset", () => {
  const modeId = codexPlanModeId("auto-review/workspace-write");
  assert.equal(modeId, "plan:auto-review/workspace-write");
  assert.equal(codexPlanAccessModeId(modeId), "auto-review/workspace-write");
  assert.equal(isCodexModeId(modeId), true);
  assert.equal(codexPlanAccessModeId("plan:not-a-mode"), null);
  assert.equal(isCodexModeId("plan:not-a-mode"), false);
});

function accessLabels(state: ReturnType<typeof buildCodexModeState>): Record<string, string> {
  return Object.fromEntries(
    state.availableModes
      .filter((mode) => mode.id !== "plan")
      .map((mode) => [mode.id, mode.label]),
  );
}

function allLabels(state: ReturnType<typeof buildCodexModeState>): Record<string, string> {
  return Object.fromEntries(state.availableModes.map((mode) => [mode.id, mode.label]));
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
