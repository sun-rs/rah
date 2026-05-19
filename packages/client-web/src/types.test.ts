import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RahEvent, SessionSummary } from "@rah/runtime-protocol";
import { deriveWorkspaceInfos, sortWorkspaceInfos } from "./session-browser";
import {
  appendOptimisticUserMessage,
  applyEventToProjection,
  initialHistorySyncState,
  markPendingInterruptIntent,
  removeOptimisticUserMessage,
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

function event(
  event: Omit<RahEvent, "id" | "seq" | "ts" | "sessionId" | "source"> & {
    seq: number;
    source?: RahEvent["source"];
  },
): RahEvent {
  const source = event.source ?? { provider: "codex", channel: "structured_live", authority: "derived" };
  return {
    id: `event-${event.seq}`,
    ts: `2026-04-15T00:00:${String(event.seq).padStart(2, "0")}.000Z`,
    sessionId: "session-1",
    ...event,
    source,
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

  test("replaces optimistic user message by clientMessageId before text fallback", () => {
    let current = appendOptimisticUserMessage(projection(), "继续", {
      clientMessageId: "client-message-1",
      clientTurnId: "client-turn-1",
    });

    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: {
            kind: "user_message",
            text: "继续",
            messageId: "provider-user-1",
            clientMessageId: "client-message-1",
            clientTurnId: "client-turn-1",
          },
        },
      }),
    );

    const userMessages = current.feed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
    );
    assert.equal(userMessages.length, 1);
    const only = userMessages[0];
    assert.equal(only?.kind === "timeline" ? only.key : null, "optimistic:user:client-message-1");
    assert.equal(
      only?.kind === "timeline" && only.item.kind === "user_message"
        ? only.item.messageId
        : null,
      "provider-user-1",
    );
    assert.equal(only?.turnId, "provider-turn-1");
  });

  test("replaces repeated optimistic user messages in provider event order", () => {
    let current = appendOptimisticUserMessage(projection(), "继续", {
      clientMessageId: "client-message-1",
      clientTurnId: "client-turn-1",
    });
    current = appendOptimisticUserMessage(current, "继续", {
      clientMessageId: "client-message-2",
      clientTurnId: "client-turn-2",
    });

    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "继续" },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "provider-turn-2",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "继续" },
        },
      }),
    );

    const userMessages = current.feed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
    );
    assert.equal(userMessages.length, 2);
    assert.deepEqual(
      userMessages.map((entry) => (entry.kind === "timeline" ? entry.turnId : null)),
      ["provider-turn-1", "provider-turn-2"],
    );
  });

  test("replaces Gemini optimistic user burst with provider composite user message", () => {
    let current = appendOptimisticUserMessage(projection(), "厉害了", {
      clientMessageId: "client-message-1",
      clientTurnId: "client-turn-1",
    });
    current = appendOptimisticUserMessage(current, "现在几点", {
      clientMessageId: "client-message-2",
      clientTurnId: "client-turn-2",
    });
    current = appendOptimisticUserMessage(current, "你无敌", {
      clientMessageId: "client-message-3",
      clientTurnId: "client-turn-3",
    });
    current = {
      ...current,
      feed: current.feed.map((entry, index) =>
        entry.kind === "timeline" && entry.key.startsWith("optimistic:user:")
          ? { ...entry, ts: `2026-04-15T00:00:0${index + 1}.000Z` }
          : entry,
      ),
    };

    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "gemini:provider-user-1",
        source: { provider: "gemini", channel: "structured_persisted", authority: "authoritative" },
        type: "timeline.item.added",
        payload: {
          item: {
            kind: "user_message",
            text: "厉害了\n\n现在几点\n\n你无敌",
            messageId: "provider-user-1",
          },
          identity: {
            canonicalItemId: "gemini-user-1",
            canonicalTurnId: "gemini-turn-1",
            provider: "gemini",
            providerSessionId: "provider-session-1",
            turnKey: "message:provider-user-1",
            itemKind: "user_message",
            itemKey: "provider-user-1",
            origin: "live",
            confidence: "native",
          },
        },
      }),
    );

    const userMessages = current.feed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
    );
    assert.equal(userMessages.length, 1);
    const only = userMessages[0];
    assert.equal(only?.kind === "timeline" ? only.canonicalItemId : null, "gemini-user-1");
    assert.equal(
      only?.kind === "timeline" && only.item.kind === "user_message" ? only.item.text : null,
      "厉害了\n\n现在几点\n\n你无敌",
    );
  });

  test("dedupes same-turn user echoes even when they arrive after assistant output", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "你是谁" },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "我是 Codex。" },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "你是谁" },
        },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) =>
        entry.kind === "timeline" ? `${entry.item.kind}:${entry.item.text}` : entry.kind,
      ),
      ["user_message:你是谁", "assistant_message:我是 Codex。"],
    );
  });

  test("drops weak user echoes that arrive after authoritative user history", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: {
            kind: "user_message",
            text: "继续",
            messageId: "provider-user-1",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "weak-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "继续" },
        },
      }),
    );

    const userMessages = current.feed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
    );
    assert.equal(userMessages.length, 1);
    assert.equal(
      userMessages[0]?.kind === "timeline" && userMessages[0].item.kind === "user_message"
        ? userMessages[0].item.messageId
        : null,
      "provider-user-1",
    );
  });

  test("upgrades optimistic native TUI user echo with canonical history identity", () => {
    let current = appendOptimisticUserMessage(projection(), "你是谁");

    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "你是谁" },
          identity: {
            canonicalItemId: "codex-history-user-1",
            canonicalTurnId: "codex-history-turn-1",
            provider: "codex",
            providerSessionId: "provider-session-1",
            turnKey: "turn:provider-turn-1",
            itemKind: "user_message",
            itemKey: "item:0",
            origin: "history",
            confidence: "derived",
          },
        },
      }),
    );

    assert.equal(current.feed.length, 1);
    const [entry] = current.feed;
    assert.equal(entry?.kind, "timeline");
    assert.equal(entry?.kind === "timeline" ? entry.canonicalItemId : null, "codex-history-user-1");
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
          item: {
            kind: "assistant_message",
            text: "我是",
            messageId: "assistant-1",
            runtimeModel: {
              modelId: "gpt-5.5",
              optionId: "xhigh",
              optionKind: "reasoning_effort",
              source: "native",
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
      assert.deepEqual(only.item.runtimeModel, {
        modelId: "gpt-5.5",
        optionId: "xhigh",
        optionKind: "reasoning_effort",
        source: "native",
      });
    }
  });

  test("upserts timeline entries by canonical item id without message ids", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "live-turn",
        type: "timeline.item.added",
        payload: {
          item: { kind: "reasoning", text: "thinking" },
          identity: {
            canonicalItemId: "canonical-item-1",
            canonicalTurnId: "canonical-turn-1",
            provider: "opencode",
            providerSessionId: "provider-session-1",
            turnKey: "turn-1",
            itemKind: "reasoning",
            itemKey: "reasoning-1",
            origin: "live",
            confidence: "derived",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "history:provider-session-1:turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "reasoning", text: "thinking final" },
          identity: {
            canonicalItemId: "canonical-item-1",
            canonicalTurnId: "canonical-turn-1",
            provider: "opencode",
            providerSessionId: "provider-session-1",
            turnKey: "turn-1",
            itemKind: "reasoning",
            itemKey: "reasoning-1",
            origin: "history",
            confidence: "derived",
          },
        },
      }),
    );

    assert.equal(current.feed.length, 1);
    const only = current.feed[0];
    assert.equal(only?.kind, "timeline");
    if (only?.kind === "timeline" && only.item.kind === "reasoning") {
      assert.equal(only.key, "timeline:canonical-item-1");
      assert.equal(only.canonicalItemId, "canonical-item-1");
      assert.equal(only.turnId, "history:provider-session-1:turn-1");
      assert.equal(only.item.text, "thinking final");
    }
  });

  test("keeps repeated text with different canonical item ids", () => {
    let current = projection();
    for (const seq of [1, 2]) {
      current = applyEventToProjection(
        current,
        event({
          seq,
          turnId: `turn-${seq}`,
          type: "timeline.item.added",
          payload: {
            item: { kind: "user_message", text: "继续" },
            identity: {
              canonicalItemId: `canonical-item-${seq}`,
              canonicalTurnId: `canonical-turn-${seq}`,
              provider: "codex",
              providerSessionId: "provider-session-1",
              turnKey: `turn-${seq}`,
              itemKind: "user_message",
              itemKey: `user-${seq}`,
              origin: "live",
              confidence: "derived",
            },
          },
        }),
      );
    }

    assert.equal(current.feed.length, 2);
    assert.deepEqual(
      current.feed.map((entry) => (entry.kind === "timeline" ? entry.canonicalItemId : null)),
      ["canonical-item-1", "canonical-item-2"],
    );
  });

  test("updates native TUI prompt state without replacing the session summary", () => {
    let current = projection();
    current.summary.session.nativeTui = {
      terminalId: "session-1",
      viewAvailable: true,
      promptState: "prompt_clean",
    };

    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        type: "session.native_tui.prompt_state.changed",
        payload: { promptState: "prompt_dirty", queuedInputCount: 1 },
      }),
    );

    assert.equal(current.summary.session.nativeTui?.promptState, "prompt_dirty");
    assert.equal(current.summary.session.nativeTui?.queuedInputCount, 1);
    assert.equal(current.summary.session.nativeTui?.terminalId, "session-1");
  });

  test("does not merge different assistant messages in the same turn", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "Repeated answer.", messageId: "assistant-1" },
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
          item: { kind: "assistant_message", text: "Repeated answer.", messageId: "assistant-2" },
        },
      }),
    );

    const messages = current.feed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "assistant_message",
    );
    assert.equal(messages.length, 2);
  });

  test("replaces assistant delta text with authoritative completed text", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: {
            kind: "assistant_message",
            text: "核心内容包括：- 项目定位：Provider CLI",
            messageId: "assistant-1",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "timeline.item.updated",
        payload: {
          item: {
            kind: "assistant_message",
            text: "核心内容包括：\n\n- **项目定位**：Provider CLI",
            messageId: "assistant-1",
          },
        },
      }),
    );

    assert.equal(current.feed.length, 1);
    const only = current.feed[0];
    assert.equal(only?.kind, "timeline");
    if (only?.kind === "timeline" && only.item.kind === "assistant_message") {
      assert.equal(only.item.text, "核心内容包括：\n\n- **项目定位**：Provider CLI");
    }
  });

  test("removes failed optimistic user messages without dropping later events", () => {
    let current = appendOptimisticUserMessage(projection(), "hello");
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-local",
        type: "runtime.status",
        payload: { status: "thinking" },
      }),
    );

    const restored = removeOptimisticUserMessage(current, "hello");

    assert.equal(
      restored.feed.some(
        (entry) =>
          entry.kind === "timeline" &&
          entry.key.startsWith("optimistic:user:") &&
          entry.item.kind === "user_message" &&
          entry.item.text === "hello",
      ),
      false,
    );
    assert.equal(restored.lastSeq, 1);
  });

  test("shows a lightweight system notice when a turn is canceled", () => {
    const current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-1",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );

    assert.equal(current.summary.session.runtimeState, "idle");
    assert.equal(current.feed.length, 1);
    const notice = current.feed[0];
    assert.equal(notice?.kind, "notification");
    if (notice?.kind === "notification") {
      assert.equal(notice.title, "Conversation interrupted");
      assert.equal(notice.body, "The previous turn was interrupted.");
      assert.equal(notice.turnId, "turn-1");
    }
  });

  test("does not duplicate turn canceled notices for the same turn", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );

    assert.equal(current.feed.length, 1);
    assert.equal(current.feed[0]?.kind, "notification");
  });

  test("does not duplicate turn canceled notices for the same canonical turn", () => {
    const canonicalIdentity = {
      canonicalTurnId: "canonical-turn-1",
      provider: "codex" as const,
      providerSessionId: "provider-session-1",
      turnKey: "turn:provider-turn-1",
      origin: "history" as const,
      confidence: "derived" as const,
    };
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "live-turn-1",
        type: "turn.canceled",
        payload: { reason: "interrupted", identity: canonicalIdentity },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "history:turn-1",
        type: "turn.canceled",
        payload: { reason: "interrupted", identity: canonicalIdentity },
      }),
    );

    assert.equal(current.feed.length, 1);
    const notice = current.feed[0];
    assert.equal(notice?.kind, "notification");
    assert.equal(notice?.key, "canonical-turn-1:turn:canceled");
  });

  test("anchors a turn canceled notice after its turn and replaces legacy duplicates", () => {
    const canonicalIdentity = {
      canonicalTurnId: "canonical-turn-1",
      provider: "codex" as const,
      providerSessionId: "provider-session-1",
      turnKey: "turn:provider-turn-1",
      origin: "live" as const,
      confidence: "derived" as const,
    };
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "你是谁" },
          identity: {
            ...canonicalIdentity,
            canonicalItemId: "canonical-item-1",
            itemKind: "user_message",
            itemKey: "item:0",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "我是 Codex。" },
          identity: {
            ...canonicalIdentity,
            canonicalItemId: "canonical-item-2",
            itemKind: "assistant_message",
            itemKey: "item:1",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "provider-turn-1",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 4,
        turnId: "provider-turn-1",
        type: "turn.canceled",
        payload: { reason: "interrupted", identity: canonicalIdentity },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) => entry.kind === "timeline" ? entry.item.kind : entry.kind),
      ["user_message", "assistant_message", "notification"],
    );
    const notices = current.feed.filter((entry) => entry.kind === "notification");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.kind, "notification");
    assert.equal(notices[0]?.interruptAnchorKey, "timeline:canonical-item-2");
  });

  test("uses the local stop intent anchor when cancel confirmation has no turn identity", () => {
    let current = projection();
    for (const item of [
      { seq: 1, turnId: "turn-1", kind: "user_message" as const, text: "第一问" },
      { seq: 2, turnId: "turn-1", kind: "assistant_message" as const, text: "第一答" },
      { seq: 3, turnId: "turn-2", kind: "user_message" as const, text: "第二问" },
      { seq: 4, turnId: "turn-2", kind: "assistant_message" as const, text: "第二答" },
    ]) {
      current = applyEventToProjection(
        current,
        event({
          seq: item.seq,
          turnId: item.turnId,
          type: "timeline.item.added",
          payload: { item: { kind: item.kind, text: item.text } },
        }),
      );
    }

    current = markPendingInterruptIntent(current);
    current = applyEventToProjection(
      current,
      event({
        seq: 5,
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 6,
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) =>
        entry.kind === "timeline" ? `${entry.item.kind}:${"text" in entry.item ? entry.item.text : ""}` : entry.kind,
      ),
      [
        "user_message:第一问",
        "assistant_message:第一答",
        "user_message:第二问",
        "assistant_message:第二答",
        "notification",
      ],
    );
    assert.equal(current.feed.filter((entry) => entry.kind === "notification").length, 1);
  });

  test("replaces an early unanchored cancel with the later anchored provider cancel", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "live-cancel-before-user",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "provider-turn",
        type: "timeline.item.added",
        payload: {
          item: {
            kind: "user_message",
            text: "Use the available shell tool to run a command that sleeps for 20 seconds.",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "provider-cancel-after-user",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) =>
        entry.kind === "timeline" ? entry.item.kind : `${entry.kind}:${entry.title}`,
      ),
      ["user_message", "notification:Conversation interrupted"],
    );
    const notices = current.feed.filter((entry) => entry.kind === "notification");
    assert.equal(notices.length, 1);
    assert.equal(
      notices[0]?.kind === "notification" ? notices[0].interruptAnchorKey : undefined,
      current.feed.find((entry) => entry.kind === "timeline" && entry.item.kind === "user_message")?.key,
    );
  });

  test("keeps one interrupt notice when provider cancel events anchor to different items in the same turn", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-user",
        type: "timeline.item.added",
        payload: { item: { kind: "user_message", text: "sleep 20" } },
      }),
    );
    current = markPendingInterruptIntent(current);
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-live-cancel",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-assistant",
        type: "timeline.item.added",
        payload: { item: { kind: "reasoning", text: "partial reasoning" } },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 4,
        turnId: "turn-history-cancel",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) =>
        entry.kind === "timeline" ? entry.item.kind : `${entry.kind}:${entry.title}`,
      ),
      ["user_message", "reasoning", "notification:Conversation interrupted"],
    );
    assert.equal(current.feed.filter((entry) => entry.kind === "notification").length, 1);
  });

  test("keeps live persisted timeline items in daemon event order", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "newer question" },
        },
      }),
    );
    current = applyEventToProjection(current, {
      ...event({
        seq: 2,
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "older answer" },
        },
      }),
      ts: "2026-04-14T23:59:00.000Z",
      source: { provider: "codex", channel: "structured_persisted", authority: "authoritative" },
    } as RahEvent);

    assert.deepEqual(
      current.feed.map((entry) =>
        entry.kind === "timeline" &&
        (entry.item.kind === "user_message" || entry.item.kind === "assistant_message")
          ? entry.item.text
          : null,
      ),
      ["newer question", "older answer"],
    );
  });

  test("does not merge identity-less assistant messages without a live turn", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "First stored answer." },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "Second stored answer." },
        },
      }),
    );

    assert.equal(current.feed.length, 2);
    assert.deepEqual(
      current.feed.map((entry) =>
        entry.kind === "timeline" && entry.item.kind === "assistant_message"
          ? entry.item.text
          : null,
      ),
      ["First stored answer.", "Second stored answer."],
    );
  });

  test("does not merge history assistant text into live message without shared identity", () => {
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

    assert.equal(current.feed.length, 2);
    assert.deepEqual(
      current.feed.map((entry) =>
        entry.kind === "timeline" && entry.item.kind === "assistant_message"
          ? {
              turnId: entry.turnId ?? null,
              messageId: entry.item.messageId ?? null,
              text: entry.item.text,
            }
          : null,
      ),
      [
        { turnId: null, messageId: null, text: "我是 Codex" },
        { turnId: "turn-1", messageId: "assistant-1", text: "我是 Codex" },
      ],
    );
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

  test("keeps retry runtime status out of the transcript feed", () => {
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

    assert.deepEqual(current.feed.map((entry) => entry.kind), []);
    assert.equal(current.currentRuntimeStatus, "retrying");
  });

  test("does not let reconnect status drift around an anchored interrupt notice", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: { item: { kind: "assistant_message", text: "休眠中" } },
      }),
    );
    current = markPendingInterruptIntent(current);
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "runtime.status",
        payload: { status: "retrying", detail: "Reconnecting... 1/5", retryCount: 1 },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 4,
        turnId: "turn-1",
        type: "runtime.status",
        payload: { status: "retrying", detail: "Reconnecting... 2/5", retryCount: 2 },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 5,
        turnId: "turn-1",
        type: "turn.canceled",
        payload: {
          reason: "interrupted",
          identity: {
            canonicalTurnId: "canonical-turn-1",
            provider: "codex",
            providerSessionId: "provider-session-1",
            turnKey: "turn-1",
            origin: "history",
            confidence: "derived",
          },
        },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) => entry.kind === "timeline" ? entry.item.kind : entry.kind),
      ["assistant_message", "notification"],
    );
    assert.equal(current.feed.filter((entry) => entry.kind === "notification").length, 1);
    assert.equal(current.currentRuntimeStatus, undefined);
  });

  test("keeps multiple delayed stop notices anchored after their own user turns", () => {
    let current = projection();

    current = appendOptimisticUserMessage(current, "休眠五秒 A");
    current = markPendingInterruptIntent(current);
    current = appendOptimisticUserMessage(current, "恢复 A");
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );

    current = appendOptimisticUserMessage(current, "休眠五秒 B");
    current = markPendingInterruptIntent(current);
    current = appendOptimisticUserMessage(current, "恢复 B");
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) =>
        entry.kind === "timeline"
          ? `${entry.item.kind}:${"text" in entry.item ? entry.item.text : ""}`
          : `${entry.kind}:${entry.kind === "notification" ? entry.title : ""}`,
      ),
      [
        "user_message:休眠五秒 A",
        "notification:Conversation interrupted",
        "user_message:恢复 A",
        "user_message:休眠五秒 B",
        "notification:Conversation interrupted",
        "user_message:恢复 B",
      ],
    );

    const notices = current.feed.filter((entry) => entry.kind === "notification");
    assert.equal(notices.length, 2);
    assert.deepEqual(
      notices.map((entry) => (entry.kind === "notification" ? entry.interruptAnchorKey : undefined)),
      [
        current.feed.find((entry) => entry.kind === "timeline" && entry.item.text === "休眠五秒 A")?.key,
        current.feed.find((entry) => entry.kind === "timeline" && entry.item.text === "休眠五秒 B")?.key,
      ],
    );
  });

  test("clears stale runtime status when daemon reports the session is idle", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        type: "runtime.status",
        payload: { status: "thinking", detail: "Thinking" },
      }),
    );
    assert.equal(current.currentRuntimeStatus, "thinking");

    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        type: "session.state.changed",
        payload: { state: "idle" },
      }),
    );

    assert.equal(current.summary.session.runtimeState, "idle");
    assert.equal(current.currentRuntimeStatus, undefined);
  });

  test("dedupes same-turn user echoes even when provider identities drift", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "你是谁", messageId: "opencode-live-user" },
          identity: {
            canonicalItemId: "opencode-live-item",
            canonicalTurnId: "opencode-turn-1",
            provider: "opencode",
            providerSessionId: "provider-session-1",
            turnKey: "message:live",
            itemKind: "user_message",
            itemKey: "part-live",
            origin: "live",
            confidence: "native",
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
          item: { kind: "user_message", text: "你是谁", messageId: "opencode-history-user" },
          identity: {
            canonicalItemId: "opencode-history-item",
            canonicalTurnId: "opencode-turn-1",
            provider: "opencode",
            providerSessionId: "provider-session-1",
            turnKey: "message:history",
            itemKind: "user_message",
            itemKey: "part-history",
            origin: "history",
            confidence: "native",
          },
        },
      }),
    );

    assert.equal(
      current.feed.filter(
        (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
      ).length,
      1,
    );
  });

  test("drops late provisional user echo after canonical provider user message", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "你是谁，你在 build 模式吗", messageId: "provider-user-1" },
          identity: {
            canonicalItemId: "opencode-user-1",
            canonicalTurnId: "opencode-turn-1",
            provider: "opencode",
            providerSessionId: "provider-session-1",
            turnKey: "message:provider-user-1",
            itemKind: "user_message",
            itemKey: "part:user-1",
            origin: "history",
            confidence: "native",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "client-turn-1",
        type: "timeline.item.added",
        payload: {
          item: {
            kind: "user_message",
            text: "你是谁，你在 build 模式吗",
            clientMessageId: "client-message-1",
            clientTurnId: "client-turn-1",
          },
        },
      }),
    );

    const userMessages = current.feed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
    );
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0]?.kind === "timeline" ? userMessages[0].canonicalItemId : null, "opencode-user-1");
  });

  test("upgrades provisional user echo when canonical provider user message arrives", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "client-turn-1",
        type: "timeline.item.added",
        payload: {
          item: {
            kind: "user_message",
            text: "你是谁，你在 build 模式吗",
            clientMessageId: "client-message-1",
            clientTurnId: "client-turn-1",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "provider-turn-1",
        type: "timeline.item.added",
        payload: {
          item: { kind: "user_message", text: "你是谁，你在 build 模式吗", messageId: "provider-user-1" },
          identity: {
            canonicalItemId: "opencode-user-1",
            canonicalTurnId: "opencode-turn-1",
            provider: "opencode",
            providerSessionId: "provider-session-1",
            turnKey: "message:provider-user-1",
            itemKind: "user_message",
            itemKey: "part:user-1",
            origin: "live",
            confidence: "native",
          },
        },
      }),
    );

    const userMessages = current.feed.filter(
      (entry) => entry.kind === "timeline" && entry.item.kind === "user_message",
    );
    assert.equal(userMessages.length, 1);
    const [only] = userMessages;
    assert.equal(only?.kind === "timeline" ? only.canonicalItemId : null, "opencode-user-1");
    assert.equal(
      only?.kind === "timeline" && only.item.kind === "user_message" ? only.item.messageId : null,
      "provider-user-1",
    );
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

  test("stores turn failure errors on the projected session diagnostics", () => {
    let current: SessionProjection = {
      ...projection(),
      summary: {
        ...baseSummary(),
        session: {
          ...baseSummary().session,
          runtimeDiagnostics: {
            lastError: "Unexpected server error. Check server logs for details.",
          },
        },
      },
    };

    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "turn.failed",
        payload: {
          error: "Model not found: niubiwudi/.",
        },
      }),
    );

    assert.equal(current.summary.session.runtimeState, "failed");
    assert.equal(
      current.summary.session.runtimeDiagnostics?.lastError,
      "Model not found: niubiwudi/.",
    );

    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "turn.failed",
        payload: {
          error: "Unexpected server error. Check server logs for details.",
        },
      }),
    );

    assert.equal(
      current.summary.session.runtimeDiagnostics?.lastError,
      "Model not found: niubiwudi/.",
    );
  });

  test("does not collapse adjacent user messages without shared identity", () => {
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
      ["user_message", "user_message"],
    );
    assert.deepEqual(
      current.feed.map((entry) => (entry.kind === "timeline" ? entry.turnId : null)),
      ["turn-1", "turn-2"],
    );
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

  test("does not reopen completed tool calls when duplicate starts arrive later", () => {
    let current = projection();
    const started = {
      toolCall: {
        id: "tool-1",
        family: "search" as const,
        providerToolName: "grep_search",
        title: "SearchText",
      },
    };
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "tool.call.started",
        payload: started,
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "tool.call.completed",
        payload: started,
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-1",
        type: "tool.call.started",
        payload: started,
      }),
    );

    const tools = current.feed.filter((entry) => entry.kind === "tool_call");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.kind, "tool_call");
    if (tools[0]?.kind === "tool_call") {
      assert.equal(tools[0].status, "completed");
    }
  });

  test("projects turn step events into a single visible timeline step", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "turn.step.started",
        payload: {
          index: 0,
          title: "OpenCode tool step",
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "turn.step.completed",
        payload: {
          index: 0,
          reason: "stop",
        },
      }),
    );

    assert.equal(current.feed.length, 1);
    const step = current.feed[0];
    assert.equal(step?.kind, "timeline");
    if (step?.kind === "timeline") {
      assert.deepEqual(step.item, {
        kind: "step",
        title: "OpenCode tool step",
        status: "completed",
        text: "stop",
      });
    }
  });

  test("hides anonymous OpenCode step markers from the visible chat feed", () => {
    let current = projection();
    current = applyEventToProjection(
      current,
      event({
        seq: 1,
        turnId: "turn-1",
        type: "turn.step.started",
        source: {
          provider: "opencode",
          channel: "structured_persisted",
          authority: "authoritative",
        },
        payload: {
          index: 1,
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-1",
        type: "turn.step.completed",
        source: {
          provider: "opencode",
          channel: "structured_persisted",
          authority: "authoritative",
        },
        payload: {
          index: 1,
          reason: "stop",
        },
      }),
    );

    assert.equal(current.feed.length, 0);
  });

  test("marks parent workspaces as blocked when a descendant running session exists", () => {
    const workspaces = deriveWorkspaceInfos(
      ["/repo", "/repo/app"],
      [workspaceSummary({ id: "live-1", rootDir: "/repo/app" })],
      [],
    );

    assert.equal(workspaces.find((workspace) => workspace.directory === "/repo")?.runningCount, 0);
    assert.equal(
      workspaces.find((workspace) => workspace.directory === "/repo")?.hasBlockingRunningSessions,
      true,
    );
    assert.equal(
      workspaces.find((workspace) => workspace.directory === "/repo/app")?.hasBlockingRunningSessions,
      true,
    );
  });

  test("preserves root workspace matching", () => {
    const workspaces = deriveWorkspaceInfos(
      ["/"],
      [workspaceSummary({ id: "live-root-child", rootDir: "/Users/sun/Code/rah" })],
      [],
    );

    assert.equal(workspaces[0]?.directory, "/");
    assert.equal(workspaces[0]?.hasBlockingRunningSessions, true);
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

    assert.equal(workspaces[0]?.runningCount, 0);
    assert.equal(workspaces[0]?.hasBlockingRunningSessions, false);
  });

  test("can hide uncontrolled running sessions from sidebar while still blocking workspace removal", () => {
    const workspaces = deriveWorkspaceInfos(
      ["/repo"],
      [],
      [],
      [workspaceSummary({ id: "live-1", rootDir: "/repo" })],
    );

    assert.equal(workspaces[0]?.runningCount, 0);
    assert.equal(workspaces[0]?.hasBlockingRunningSessions, true);
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

  test("clears unresolved approval cards when their turn is canceled", () => {
    let current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-approval",
        type: "timeline.item.added",
        payload: {
          item: { kind: "assistant_message", text: "I need approval." },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-approval",
        type: "permission.requested",
        payload: {
          request: {
            id: "perm-approval",
            kind: "tool",
            title: "Apply file changes",
          },
        },
      }),
    );
    assert.equal(current.feed.some((entry) => entry.kind === "permission"), true);

    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-approval",
        type: "turn.canceled",
        payload: { reason: "interrupted" },
      }),
    );

    assert.deepEqual(
      current.feed.map((entry) => entry.kind),
      ["timeline", "notification"],
    );
  });

  test("does not duplicate approval cards when the same request is re-emitted", () => {
    let current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-approval",
        type: "permission.requested",
        payload: {
          request: {
            id: "perm-approval",
            kind: "tool",
            title: "Apply file changes",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-approval",
        type: "permission.requested",
        payload: {
          request: {
            id: "perm-approval",
            kind: "tool",
            title: "Apply file changes again",
          },
        },
      }),
    );

    const permissionEntries = current.feed.filter((entry) => entry.kind === "permission");
    assert.equal(permissionEntries.length, 1);
    assert.equal(permissionEntries[0]?.request.title, "Apply file changes again");
  });

  test("removes resolved approval cards after response", () => {
    let current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-approved",
        type: "permission.requested",
        payload: {
          request: {
            id: "perm-approved",
            kind: "tool",
            title: "Apply file changes",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-approved",
        type: "permission.resolved",
        payload: {
          resolution: {
            requestId: "perm-approved",
            behavior: "allow",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-approved",
        type: "turn.completed",
        payload: {},
      }),
    );

    assert.equal(current.feed.filter((entry) => entry.kind === "permission").length, 0);
  });

  test("clears pending approval cards when a turn completes without a resolution", () => {
    let current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-pending",
        type: "permission.requested",
        payload: {
          request: {
            id: "perm-pending",
            kind: "tool",
            title: "Apply file changes",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-pending",
        type: "turn.completed",
        payload: {},
      }),
    );

    assert.equal(current.feed.filter((entry) => entry.kind === "permission").length, 0);
  });

  test("does not regress a resolved approval back to pending after a stale request replay", () => {
    let current = applyEventToProjection(
      projection(),
      event({
        seq: 1,
        turnId: "turn-approved",
        type: "permission.requested",
        payload: {
          request: {
            id: "perm-approved",
            kind: "tool",
            title: "Apply file changes",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 2,
        turnId: "turn-approved",
        type: "permission.resolved",
        payload: {
          resolution: {
            requestId: "perm-approved",
            behavior: "allow",
          },
        },
      }),
    );
    current = applyEventToProjection(
      current,
      event({
        seq: 3,
        turnId: "turn-approved",
        type: "permission.requested",
        payload: {
          request: {
            id: "perm-approved",
            kind: "tool",
            title: "Apply file changes",
          },
        },
      }),
    );

    const permissionEntries = current.feed.filter((entry) => entry.kind === "permission");
    assert.equal(permissionEntries.length, 0);
  });

  test("applies daemon lifecycle events even when optimistic UI updatedAt is newer", () => {
    let current: SessionProjection = {
      ...projection(),
      summary: {
        ...baseSummary(),
        session: {
          ...baseSummary().session,
          runtimeState: "idle",
          updatedAt: "2026-04-15T00:00:10.000Z",
          nativeTui: {
            terminalId: "session-1",
            viewAvailable: true,
            promptState: "prompt_clean",
          },
        },
      },
    };

    current = applyEventToProjection(
      current,
      {
        ...event({
          seq: 11,
          type: "session.state.changed",
          payload: { state: "running" },
        }),
        ts: "2026-04-15T00:00:09.000Z",
      },
    );
    current = applyEventToProjection(
      current,
      {
        ...event({
          seq: 12,
          type: "session.native_tui.prompt_state.changed",
          payload: { promptState: "agent_busy" },
        }),
        ts: "2026-04-15T00:00:09.500Z",
      },
    );

    assert.equal(current.summary.session.runtimeState, "running");
    assert.equal(current.summary.session.nativeTui?.promptState, "agent_busy");
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
