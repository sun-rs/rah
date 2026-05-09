import test from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary } from "@rah/runtime-protocol";
import {
  canSessionArchive,
  canSessionSwitchModel,
  canSessionSwitchModes,
  isSessionControlLocked,
  isSessionGenerationActive,
} from "./session-capabilities";

function summaryWithSession(args?: Partial<SessionSummary["session"]>): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "codex",
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "idle",
      ptyId: "pty-1",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: false,
        rawPtyInput: false,
        chatMirror: false,
        structuredControl: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: false,
        actions: {
          info: true,
          archive: true,
          delete: false,
          rename: "none",
        },
        steerInput: true,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
      ...args,
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function summaryWithArchiveCapability(archive: boolean): SessionSummary {
  return summaryWithSession({
    capabilities: {
      ...summaryWithSession().session.capabilities,
      actions: {
        ...summaryWithSession().session.capabilities.actions,
        archive,
      },
    },
  });
}

test("canSessionArchive follows the provider action capability", () => {
  assert.equal(canSessionArchive(summaryWithArchiveCapability(true)), true);
  assert.equal(canSessionArchive(summaryWithArchiveCapability(false)), false);
});

test("native TUI sessions do not expose RAH-managed mode or model controls", () => {
  const summary = summaryWithSession({
    nativeTui: {
      terminalId: "session-1",
      viewAvailable: true,
      promptState: "prompt_clean",
    },
    capabilities: {
      ...summaryWithSession().session.capabilities,
      nativeTui: true,
      rawPtyInput: true,
      structuredControl: false,
      modelSwitch: true,
      planMode: true,
    },
    mode: {
      currentModeId: "plan",
      availableModes: [
        {
          id: "plan",
          label: "Plan",
          role: "plan",
          applyTiming: "immediate",
          hotSwitch: true,
        },
      ],
      mutable: true,
      source: "external_locked",
    },
    model: {
      currentModelId: "gpt-test",
      availableModels: [
        {
          id: "gpt-test",
          label: "gpt-test",
        },
      ],
      mutable: true,
      source: "native",
    },
  });

  assert.equal(canSessionSwitchModes(summary), false);
  assert.equal(canSessionSwitchModel(summary), false);
});

test("runtime config feature gates live mode and model controls", () => {
  const summary = summaryWithSession({
    runtime: {
      kind: "native_local_server",
      protocolStability: "project_native",
      liveSource: "provider_server",
      tuiRole: "none",
      structuredLiveEvents: true,
      tuiContinuity: false,
      features: {
        structuredLiveEvents: "available",
        structuredControl: "available",
        historyBackfill: "available",
        tuiClientContinuity: "unsupported",
        crossClientSync: "unverified",
        prelaunchConfig: "available",
        runtimeConfig: "unverified",
        interrupt: "unverified",
        archiveLifecycle: "unverified",
      },
    },
    capabilities: {
      ...summaryWithSession().session.capabilities,
      structuredControl: true,
      modelSwitch: true,
    },
    mode: {
      currentModeId: "default",
      availableModes: [{ id: "default", label: "Default" }],
      mutable: true,
      source: "native",
    },
    model: {
      currentModelId: "gpt-test",
      availableModels: [{ id: "gpt-test", label: "gpt-test" }],
      mutable: true,
      source: "native",
    },
  });

  assert.equal(canSessionSwitchModes(summary), false);
  assert.equal(canSessionSwitchModel(summary), false);

  const available = {
    ...summary,
    session: {
      ...summary.session,
      runtime: {
        ...summary.session.runtime!,
        features: {
          ...summary.session.runtime!.features!,
          runtimeConfig: "available" as const,
        },
      },
    },
  };
  assert.equal(canSessionSwitchModes(available), true);
  assert.equal(canSessionSwitchModel(available), true);
});

test("session controls are unlocked after failed and stopped states", () => {
  const summary = summaryWithArchiveCapability(true);
  assert.equal(
    isSessionControlLocked({
      ...summary,
      session: { ...summary.session, runtimeState: "running" },
    }),
    true,
  );
  assert.equal(
    isSessionControlLocked({
      ...summary,
      session: { ...summary.session, runtimeState: "waiting_permission" },
    }),
    true,
  );
  assert.equal(
    isSessionControlLocked({
      ...summary,
      session: { ...summary.session, runtimeState: "failed" },
    }),
    false,
  );
  assert.equal(
    isSessionControlLocked({
      ...summary,
      session: { ...summary.session, runtimeState: "stopped" },
    }),
    false,
  );
});

test("generation state also respects live runtime status when summary sync lags", () => {
  const summary = summaryWithArchiveCapability(true);
  assert.equal(isSessionGenerationActive(summary, undefined), false);
  assert.equal(isSessionGenerationActive(summary, "thinking"), true);
  assert.equal(isSessionGenerationActive(summary, "streaming"), true);
  assert.equal(isSessionGenerationActive(summary, "retrying"), true);
  assert.equal(
    isSessionGenerationActive(
      {
        ...summary,
        session: { ...summary.session, runtimeState: "running" },
      },
      undefined,
    ),
    true,
  );
});
