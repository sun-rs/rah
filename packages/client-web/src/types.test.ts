import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import { deriveWorkspaceInfos, sortWorkspaceInfos } from "./session-browser";
import {
  appendOptimisticUserMessage,
  applyEventToProjection,
  initialHistorySyncState,
  type SessionProjection,
} from "./types";

function baseSummary(): SessionSummary {
  return {
    session: {
      id: "session-1",
      provider: "codex",
      launchSource: "web",
      cwd: "/workspace/rah",
      rootDir: "/workspace/rah",
      runtimeState: "running",
      ptyId: "pty-1",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        steerInput: false,
        queuedInput: false,
        modelSwitch: false,
        planMode: false,
        subagents: false,
      },
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-1" },
  };
}

function projection(): SessionProjection {
  return {
    summary: baseSummary(),
    feed: [],
    events: [],
    lastSeq: 0,
    history: initialHistorySyncState(),
  };
}

function event(event: Omit<RahEvent, "id" | "seq" | "ts" | "sessionId" | "source"> & { seq: number }): RahEvent {
  return {
    id: `event-${event.seq}`,
    ts: `2026-04-15T00:00:${String(event.seq).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    source: { provider: "codex", channel: "structured_live", authority: "derived" },
    ...event,
  } as RahEvent;
}

function workspaceSummary(args: {
  id: string;
  rootDir: string;
  cwd?: string;
  steerInput?: boolean;
  livePermissions?: boolean;
  updatedAt?: string;
}): SessionSummary {
  return {
    session: {
      ...baseSummary().session,
      id: args.id,
      providerSessionId: `${args.id}-provider`,
      cwd: args.cwd ?? args.rootDir,
      rootDir: args.rootDir,
      updatedAt: args.updatedAt ?? baseSummary().session.updatedAt,
      capabilities: {
        ...baseSummary().session.capabilities,
        steerInput: args.steerInput ?? true,
        livePermissions: args.livePermissions ?? true,
      },
    },
    attachedClients: [],
    controlLease: { sessionId: args.id },
  };
}

describe("client projection", () => {
  test("does not duplicate optimistic user text or transcript message parts", () => {
    let current = appendOptimisticUserMessage(projection(), "你是谁");

    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "message.part.added",
        payload: {
          part: {
            messageId: "user-1",
            partId: "user-1",
            kind: "text",
            text: "你是谁",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "你是谁" },
        },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) => ({ kind: entry.kind, itemKind: entry.kind === "timeline" ? entry.item.kind : undefined })),
      [{ kind: "timeline", itemKind: "user_message" }],
    );
    assert.equal(current.feed[0]?.turnId, "turn-1");
  });

  test("keeps non-transcript message parts as structured cards", () => {
    const current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-1",
        type: "message.part.added",
        payload: {
          part: {
            messageId: "file-1",
            partId: "file-1",
            kind: "file",
            text: "package.json",
          },
        },
      }),
    );

    assert.deepEqual(current.feed.map((entry) => entry.kind), ["message_part"]);
  });

  test("merges assistant deltas and completed message by messageId", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "我是", messageId: "assistant-1" },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: " Codex", messageId: "assistant-1" },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "我是 Codex", messageId: "assistant-1" },
        },
      }),
    );

    assert.equal(current.feed.length, 1);
    const only = current.feed[0];
    assert.equal(only?.kind, "timeline");
    if (only?.kind === "timeline" && only.item.kind === "assistant_message") {
      assert.equal(only.item.text, "我是 Codex");
      assert.equal(only.item.messageId, "assistant-1");
    }
  });

  test("upgrades history assistant text into authoritative live message without duplicating", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "我是 Codex" },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "我是 Codex", messageId: "assistant-1" },
        },
      }),
    );

    assert.equal(current.feed.length, 1);
    const only = current.feed[0];
    assert.equal(only?.kind, "timeline");
    if (only?.kind === "timeline" && only.item.kind === "assistant_message") {
      assert.equal(only.turnId, "turn-1");
      assert.equal(only.item.messageId, "assistant-1");
      assert.equal(only.item.text, "我是 Codex");
    }
  });

  test("resets live projection when the same terminal session rebinds to a new provider session", () => {
    let current = projection();
    current.summary = {
      ...current.summary,
      session: {
        ...current.summary.session,
        launchSource: "terminal",
        providerSessionId: "thread-1",
      },
    };
    current.feed = [
      {
        kind: "timeline",
        key: "old",
        item: { kind: "assistant_message", text: "old session output" },
        ts: "2026-04-15T00:00:01.000Z",
      },
    ];
    current.history = {
      phase: "ready",
      nextCursor: "cursor-1",
      nextBeforeTs: "2026-04-15T00:00:01.000Z",
      generation: 3,
      authoritativeApplied: true,
      lastError: "old error",
    };

    const reboundEvent = event({
      seq: 3,
      type: "session.started",
      payload: {
        session: {
          ...current.summary.session,
          providerSessionId: "thread-2",
          title: "New active thread",
        },
      },
    });
    const rebound = applyEventToProjection(current, reboundEvent);

    assert.equal(rebound.summary.session.providerSessionId, "thread-2");
    assert.equal(rebound.summary.session.title, "New active thread");
    assert.deepEqual(rebound.feed, []);
    assert.deepEqual(rebound.history, initialHistorySyncState());
    assert.deepEqual(rebound.events, [reboundEvent]);
  });

  test("coalesces retry runtime status and hides non-actionable runtime status", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        type: "runtime.status",
        payload: {
          status: "session_active",
          detail: "Thread started",
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "runtime.status",
        payload: {
          status: "retrying",
          detail: "Reconnecting... 2/5",
          retryCount: 2,
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-1",
        type: "runtime.status",
        payload: {
          status: "retrying",
          detail: "Reconnecting... 5/5",
          retryCount: 5,
        },
      }),
    );

    assert.deepEqual(current.feed.map((entry) => entry.kind), ["runtime_status"]);
    const runtime = current.feed[0];
    assert.equal(runtime?.kind, "runtime_status");
    if (runtime?.kind === "runtime_status") {
      assert.equal(runtime.detail, "Reconnecting... 5/5");
      assert.equal(runtime.retryCount, 5);
    }
    assert.equal(current.currentRuntimeStatus, "retrying");
  });

  test("updates session runtimeState from turn lifecycle events", () => {
    let current: SessionProjection = {
      ...projection(),
      summary: {
        ...baseSummary(),
        session: {
          ...baseSummary().session,
          runtimeState: "idle",
        },
      },
    };

    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "turn.started",
        payload: {},
      }),
    );

    assert.equal(current.summary.session.runtimeState, "running");

    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "turn.completed",
        payload: {},
      }),
    );

    assert.equal(current.summary.session.runtimeState, "idle");
    assert.equal(current.currentRuntimeStatus, undefined);
  });

  test("collapses adjacent duplicate user message echoes", () => {
    let current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "重复问题" },
        },
      }),
    );

    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-2",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "重复问题" },
        },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) => entry.kind === "timeline" ? entry.item.kind : entry.kind),
      ["user_message"],
    );
    assert.equal(current.feed[0]?.turnId, "turn-2");
  });

  test("keeps intentional repeated user messages after an assistant response", () => {
    let current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "再问一次" },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "回答" },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-2",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "再问一次" },
        },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) => entry.kind === "timeline" ? entry.item.kind : entry.kind),
      ["user_message", "assistant_message", "user_message"],
    );
  });

  test("coalesces streaming tool output artifacts into one card detail", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "tool.call.started",
        payload: {
          toolCall: {
            id: "tool-1",
            family: "shell",
            providerToolName: "exec_command",
            title: "Run command",
            detail: {
              artifacts: [{ kind: "command", command: "printf hi" }],
            },
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "tool.call.delta",
        payload: {
          toolCallId: "tool-1",
          detail: {
            artifacts: [{ kind: "text", label: "stdout", text: "he" }],
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-1",
        type: "tool.call.delta",
        payload: {
          toolCallId: "tool-1",
          detail: {
            artifacts: [{ kind: "text", label: "stdout", text: "llo" }],
          },
        },
      }),
    );

    const tool = current.feed[0];
    assert.equal(tool?.kind, "tool_call");
    if (tool?.kind === "tool_call") {
      assert.deepEqual(tool.toolCall.detail?.artifacts, [
        { kind: "command", command: "printf hi" },
        { kind: "text", label: "stdout", text: "hello" },
      ]);
    }
  });

  test("keeps standalone completed tool calls when started event was not projected", () => {
    const current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-1",
        type: "tool.call.completed",
        payload: {
          toolCall: {
            id: "patch-1",
            family: "patch",
            providerToolName: "fileChange",
            title: "Apply file changes",
            detail: {
              artifacts: [{ kind: "diff", format: "unified", text: "@@\n-old\n+new" }],
            },
            result: { success: true },
          },
        },
      }),
    );

    assert.equal(current.feed.length, 1);
    const tool = current.feed[0];
    assert.equal(tool?.kind, "tool_call");
    if (tool?.kind === "tool_call") {
      assert.equal(tool.status, "completed");
      assert.equal(tool.toolCall.family, "patch");
    }
  });

  test("marks parent workspaces as blocked when a descendant live session exists", () => {
    const workspaces = deriveWorkspaceInfos(
      ["/repo", "/repo/app"],
      [workspaceSummary({ id: "live-1", rootDir: "/repo/app" })],
      [],
    );

    assert.equal(workspaces.find((workspace) => workspace.directory === "/repo")?.liveCount, 0);
    assert.equal(
      workspaces.find((workspace) => workspace.directory === "/repo")?.hasBlockingLiveSessions,
      true,
    );
    assert.equal(
      workspaces.find((workspace) => workspace.directory === "/repo/app")?.hasBlockingLiveSessions,
      true,
    );
  });

  test("does not block workspace removal for read-only replay sessions", () => {
    const workspaces = deriveWorkspaceInfos(
      ["/repo"],
      [
        workspaceSummary({
          id: "replay-1",
          rootDir: "/repo",
          steerInput: false,
          livePermissions: false,
        }),
      ],
      [],
    );

    assert.equal(workspaces[0]?.liveCount, 0);
    assert.equal(workspaces[0]?.hasBlockingLiveSessions, false);
  });

  test("can hide uncontrolled live sessions from sidebar while still blocking workspace removal", () => {
    const workspaces = deriveWorkspaceInfos(
      ["/repo"],
      [],
      [],
      [workspaceSummary({ id: "live-1", rootDir: "/repo" })],
    );

    assert.equal(workspaces[0]?.liveCount, 0);
    assert.equal(workspaces[0]?.hasBlockingLiveSessions, true);
  });

  test("preserves workspace display order even when a later workspace is more recently active", () => {
    const workspaces = deriveWorkspaceInfos(
      ["/workspace/first", "/workspace/second"],
      [
        workspaceSummary({
          id: "session-second",
          rootDir: "/workspace/second",
          updatedAt: "2026-04-16T00:00:00.000Z",
        }),
        workspaceSummary({
          id: "session-first",
          rootDir: "/workspace/first",
          updatedAt: "2026-04-15T00:00:00.000Z",
        }),
      ],
      [],
    );

    assert.deepEqual(
      workspaces.map((workspace) => workspace.directory),
      ["/workspace/first", "/workspace/second"],
    );
  });

  test("sorts workspaces by latest update when requested", () => {
    const workspaces = deriveWorkspaceInfos(
      ["/workspace/first", "/workspace/second"],
      [
        workspaceSummary({
          id: "session-second",
          rootDir: "/workspace/second",
          updatedAt: "2026-04-16T00:00:00.000Z",
        }),
        workspaceSummary({
          id: "session-first",
          rootDir: "/workspace/first",
          updatedAt: "2026-04-15T00:00:00.000Z",
        }),
      ],
      [],
    );

    const sorted = sortWorkspaceInfos(workspaces, "updated");

    assert.deepEqual(
      sorted.map((workspace) => workspace.directory),
      ["/workspace/second", "/workspace/first"],
    );
  });

  test("updates session runtimeState to waiting_permission when approval is requested", () => {
    const current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        type: "permission.requested",
        payload: {
          request: {
            id: "perm-1",
            kind: "tool",
            title: "Allow command",
          },
        },
      }),
    );

    assert.equal(current.summary.session.runtimeState, "waiting_permission");
  });

  test("does not let stale control events override a fresher claimed summary", () => {
    const current = applyEventToProjection(
      {
        ...projection(),
        summary: {
          ...baseSummary(),
          session: {
            ...baseSummary().session,
            updatedAt: "2026-04-15T00:00:10.000Z",
          },
          controlLease: {
            sessionId: "session-1",
            holderClientId: "web-current",
            holderKind: "web",
            grantedAt: "2026-04-15T00:00:10.000Z",
          },
        },
      },
      {
        ...event({
          seq: 11,
          type: "control.released",
          payload: {},
        }),
        ts: "2026-04-15T00:00:09.000Z",
      },
    );

    assert.equal(current.summary.controlLease.holderClientId, "web-current");
    assert.equal(current.summary.session.updatedAt, "2026-04-15T00:00:10.000Z");
  });
});
