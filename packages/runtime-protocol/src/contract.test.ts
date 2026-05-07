import assert from "node:assert/strict";
import test from "node:test";
import { validateProviderModelCatalog, validateRahEvent } from "./contract";

const baseCatalog = {
  provider: "codex",
  models: [],
  fetchedAt: "2026-04-29T00:00:00.000Z",
  source: "native",
  modes: [
    {
      id: "never/danger-full-access",
      role: "full_auto",
      label: "Full auto",
      applyTiming: "next_turn",
      hotSwitch: true,
    },
  ],
};

test("provider model catalog accepts canonical mode apply timing", () => {
  const report = validateProviderModelCatalog(baseCatalog);
  assert.equal(report.ok, true);
});

test("provider model catalog rejects non-canonical mode apply timing", () => {
  const report = validateProviderModelCatalog({
    ...baseCatalog,
    modes: [
      {
        ...baseCatalog.modes[0],
        applyTiming: "after_lunch",
      },
    ],
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0]?.code, "provider.catalog.mode.apply_timing.invalid");
});

test("session capability contract warns when legacy rename flag drifts from actions.rename", () => {
  const issues = validateRahEvent({
    id: "evt-1",
    seq: 1,
    ts: "2026-04-29T00:00:00.000Z",
    sessionId: "session-1",
    type: "session.created",
    source: { provider: "system", channel: "system", authority: "authoritative" },
    payload: {
      session: {
        id: "session-1",
        provider: "gemini",
        providerSessionId: "gemini-1",
        launchSource: "web",
        cwd: "/tmp/rah",
        rootDir: "/tmp/rah",
        runtimeState: "idle",
        ptyId: "pty-1",
        capabilities: {
          liveAttach: true,
          structuredTimeline: true,
          nativeTui: false,
          rawPtyInput: false,
          chatMirror: false,
          structuredControl: true,
          livePermissions: false,
          contextUsage: true,
          resumeByProvider: true,
          listProviderSessions: true,
          renameSession: false,
          actions: {
            info: true,
            archive: true,
            delete: true,
            rename: "local",
          },
          steerInput: true,
          queuedInput: false,
          modelSwitch: true,
          planMode: true,
          subagents: false,
        },
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z",
      },
    },
  });
  assert.equal(issues.some((issue) => issue.severity === "error"), false);
  assert.equal(
    issues.some((issue) => issue.code === "session.capabilities.rename_legacy_mismatch"),
    true,
  );
});

test("native TUI prompt state events use canonical values", () => {
  const valid = validateRahEvent({
    id: "evt-native-prompt-1",
    seq: 1,
    ts: "2026-04-29T00:00:00.000Z",
    sessionId: "session-1",
    type: "session.native_tui.prompt_state.changed",
    source: { provider: "system", channel: "system", authority: "authoritative" },
    payload: { promptState: "prompt_dirty" },
  });
  assert.equal(valid.some((issue) => issue.severity === "error"), false);

  const invalid = validateRahEvent({
    id: "evt-native-prompt-2",
    seq: 2,
    ts: "2026-04-29T00:00:01.000Z",
    sessionId: "session-1",
    type: "session.native_tui.prompt_state.changed",
    source: { provider: "system", channel: "system", authority: "authoritative" },
    payload: { promptState: "clean" },
  } as never);
  assert.equal(
    invalid.some((issue) => issue.code === "session.native_tui.prompt_state.invalid"),
    true,
  );
});
