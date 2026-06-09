import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@rah/runtime-protocol";
import { createEmptySessionProjection } from "./session-store-session-lifecycle";
import { resolveVisibleSessionHistoryTailSessionIds } from "./session-history-tail-targets";

function summary(args: {
  id: string;
  provider?: SessionSummary["session"]["provider"];
  providerSessionId?: string;
  readOnlyReplay?: boolean;
  structuredLiveEvents?: boolean;
  liveBackend?: SessionSummary["session"]["liveBackend"];
}): SessionSummary {
  const providerSessionId = args.providerSessionId ?? `${args.id}-provider`;
  const readOnlyReplay = args.readOnlyReplay === true;
  const structuredLiveEvents = args.structuredLiveEvents ?? false;
  return {
    session: {
      id: args.id,
      provider: args.provider ?? "claude",
      providerSessionId,
      launchSource: "web",
      liveBackend: args.liveBackend ?? "tui_mux",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      runtimeState: "idle",
      runtime: {
        structuredLiveEvents,
        features: {
          structuredLiveEvents: structuredLiveEvents ? "available" : "unsupported",
        },
      },
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: !readOnlyReplay,
        rawPtyInput: !readOnlyReplay,
        chatMirror: true,
        structuredControl: false,
        livePermissions: !readOnlyReplay,
        contextUsage: false,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: false,
        actions: { info: true, stop: true, delete: false, rename: "none" },
        steerInput: !readOnlyReplay,
        queuedInput: true,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: args.id },
  };
}

test("visible session history tail targets are shared across single and canvas surfaces", () => {
  const tuiBacked = createEmptySessionProjection(
    summary({
      id: "claude-live",
      provider: "claude",
      providerSessionId: "claude-provider",
      structuredLiveEvents: false,
      liveBackend: "tui_mux",
    }),
  );
  const structured = createEmptySessionProjection(
    summary({
      id: "codex-live",
      provider: "codex",
      providerSessionId: "codex-provider",
      structuredLiveEvents: true,
      liveBackend: "native_local_server",
    }),
  );
  const history = createEmptySessionProjection(
    summary({
      id: "history-1",
      provider: "gemini",
      providerSessionId: "history-provider",
      readOnlyReplay: true,
      structuredLiveEvents: false,
      liveBackend: "tui_mux",
    }),
  );

  assert.deepEqual(
    resolveVisibleSessionHistoryTailSessionIds([
      tuiBacked,
      structured,
      history,
      null,
      tuiBacked,
    ]),
    ["claude-live"],
  );
});
