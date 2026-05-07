import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  maybeRecordNativeTuiBindingMissingDiagnostic,
  maybeRecordNativeTuiMirrorSourceMissingDiagnostic,
  NativeTuiDiagnosticStore,
  recordNativeTuiMirrorFailureDiagnostic,
  recordNativeTuiProcessExitDiagnostic,
  resolveNativeTuiBindingDiagnostic,
  resolveNativeTuiMirrorFailureDiagnostic,
  resolveNativeTuiMirrorSourceDiagnostic,
} from "./native-tui-diagnostics";

describe("NativeTuiDiagnosticStore", () => {
  test("lists active diagnostics by default and resolved diagnostics on request", () => {
    const store = new NativeTuiDiagnosticStore();

    store.upsert({
      sessionId: "session-a",
      provider: "codex",
      kind: "binding_missing",
      severity: "warning",
      message: "binding missing",
      cwd: "/tmp/project",
      elapsedMs: 30_000,
    });

    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.status, "active");

    store.resolve("session-a", "binding_missing", {
      providerSessionId: "provider-a",
      details: { resolution: "provider_session_bound" },
    });

    assert.equal(store.list().length, 0);
    const resolved = store.list({ includeResolved: true });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.status, "resolved");
    assert.equal(resolved[0]?.providerSessionId, "provider-a");
    assert.equal(resolved[0]?.details?.resolution, "provider_session_bound");
  });

  test("filters diagnostics by session id", () => {
    const store = new NativeTuiDiagnosticStore();
    store.upsert({
      sessionId: "session-a",
      provider: "codex",
      kind: "binding_missing",
      severity: "warning",
      message: "binding missing",
      cwd: "/tmp/a",
    });
    store.upsert({
      sessionId: "session-b",
      provider: "claude",
      providerSessionId: "provider-b",
      kind: "mirror_source_missing",
      severity: "warning",
      message: "mirror missing",
      cwd: "/tmp/b",
    });

    const filtered = store.list({ sessionId: "session-b" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.sessionId, "session-b");
    assert.equal(filtered[0]?.kind, "mirror_source_missing");
  });

  test("clearSession resolves active diagnostics instead of deleting evidence", () => {
    const store = new NativeTuiDiagnosticStore();
    store.upsert({
      sessionId: "session-a",
      provider: "gemini",
      kind: "binding_missing",
      severity: "warning",
      message: "binding missing",
      cwd: "/tmp/project",
    });

    store.clearSession("session-a");

    assert.equal(store.list({ sessionId: "session-a" }).length, 0);
    const resolved = store.list({ sessionId: "session-a", includeResolved: true });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.status, "resolved");
    assert.equal(resolved[0]?.details?.resolution, "session_closed");
  });

  test("records and resolves delayed binding diagnostics", () => {
    const store = new NativeTuiDiagnosticStore();
    const warnings: unknown[] = [];
    const recorded = maybeRecordNativeTuiBindingMissingDiagnostic(
      store,
      {
        sessionId: "session-a",
        provider: "codex",
        cwd: "/tmp/project",
        startupTimestampMs: 1_000,
      },
      30_000,
      { nowMs: 31_000, logger: { warn: (...args) => warnings.push(args) } },
    );

    assert.equal(recorded, true);
    assert.equal(warnings.length, 1);
    assert.equal(store.list()[0]?.kind, "binding_missing");
    assert.equal(store.list()[0]?.elapsedMs, 30_000);

    resolveNativeTuiBindingDiagnostic(store, "session-a", "provider-a");
    const resolved = store.list({ includeResolved: true })[0];
    assert.equal(resolved?.status, "resolved");
    assert.equal(resolved?.providerSessionId, "provider-a");
    assert.equal(resolved?.details?.resolution, "provider_session_bound");
  });

  test("does not record binding diagnostics before the threshold", () => {
    const store = new NativeTuiDiagnosticStore();
    const recorded = maybeRecordNativeTuiBindingMissingDiagnostic(
      store,
      {
        sessionId: "session-a",
        provider: "codex",
        cwd: "/tmp/project",
        startupTimestampMs: 1_000,
      },
      30_000,
      { nowMs: 30_999, logger: { warn: () => assert.fail("should not log") } },
    );

    assert.equal(recorded, false);
    assert.equal(store.list().length, 0);
  });

  test("records process exit diagnostics with exit evidence", () => {
    const store = new NativeTuiDiagnosticStore();
    recordNativeTuiProcessExitDiagnostic(
      store,
      {
        sessionId: "session-a",
        provider: "gemini",
        providerSessionId: "provider-a",
        cwd: "/tmp/project",
        startupTimestampMs: 1_000,
      },
      { exitCode: 137, signal: "SIGKILL" },
    );

    const diagnostic = store.list()[0];
    assert.equal(diagnostic?.kind, "process_exited");
    assert.equal(diagnostic?.severity, "warning");
    assert.equal(diagnostic?.providerSessionId, "provider-a");
    assert.equal(diagnostic?.details?.exitCode, 137);
    assert.equal(diagnostic?.details?.signal, "SIGKILL");
  });

  test("records and resolves mirror diagnostics", () => {
    const store = new NativeTuiDiagnosticStore();
    const warnings: unknown[] = [];
    const session = {
      sessionId: "session-a",
      provider: "kimi" as const,
      providerSessionId: "provider-a",
      cwd: "/tmp/project",
      startupTimestampMs: 1_000,
    };

    assert.equal(
      maybeRecordNativeTuiMirrorSourceMissingDiagnostic(store, session, 30_000, {
        nowMs: 31_000,
        logger: { warn: (...args) => warnings.push(args) },
      }),
      true,
    );
    assert.equal(store.list()[0]?.kind, "mirror_source_missing");
    resolveNativeTuiMirrorSourceDiagnostic(store, session);
    assert.equal(store.list({ includeResolved: true })[0]?.details?.resolution, "mirror_source_available");

    assert.equal(
      recordNativeTuiMirrorFailureDiagnostic(store, session, new Error("boom"), "read", {
        nowMs: 32_000,
        logger: { warn: (...args) => warnings.push(args) },
      }),
      true,
    );
    assert.equal(
      recordNativeTuiMirrorFailureDiagnostic(store, session, "still broken", "read", {
        alreadyLogged: true,
        nowMs: 33_000,
        logger: { warn: () => assert.fail("should not log again") },
      }),
      false,
    );
    const failure = store.list().find((diagnostic) => diagnostic.kind === "mirror_failed");
    assert.equal(failure?.details?.phase, "read");
    assert.equal(failure?.details?.error, "still broken");
    assert.equal(resolveNativeTuiMirrorFailureDiagnostic(store, session), true);
    assert.equal(warnings.length, 2);
  });
});
