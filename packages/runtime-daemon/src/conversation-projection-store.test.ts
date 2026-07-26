import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationProjection } from "@rah/runtime-protocol";
import {
  createCodexRolloutTranslationState,
  translateCodexRolloutLine,
} from "./codex-rollout-activity";
import { ConversationProjectionStore } from "./conversation-projection-store";
import { conversationEventBelongsToLiveProjection } from "./conversation-live-policy";
import { EventBus } from "./event-bus";
import { applyProviderActivity } from "./provider-activity";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

const source = {
  provider: "codex" as const,
  channel: "structured_live" as const,
  authority: "authoritative" as const,
};

test("conversation live policy keeps persisted replay out of structured and stored runtimes", () => {
  const persistedEvent = {
    id: "persisted-1",
    seq: 1,
    ts: "2026-07-11T00:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {},
  } as const;
  const structuredRuntime = {
    runtime: { kind: "native_local_server", structuredLiveEvents: true },
  } as never;
  const storedRuntime = {
    runtime: { kind: "stored_history", structuredLiveEvents: false },
  } as never;
  const jsonlRuntime = {
    runtime: { kind: "tui_mux_fallback", structuredLiveEvents: false },
  } as never;

  assert.equal(
    conversationEventBelongsToLiveProjection(structuredRuntime, persistedEvent),
    false,
  );
  assert.equal(
    conversationEventBelongsToLiveProjection(storedRuntime, persistedEvent),
    false,
  );
  assert.equal(
    conversationEventBelongsToLiveProjection(jsonlRuntime, persistedEvent),
    true,
  );
  assert.equal(conversationEventBelongsToLiveProjection(undefined, persistedEvent), false);
  assert.equal(
    conversationEventBelongsToLiveProjection(structuredRuntime, {
      ...persistedEvent,
      source,
    }),
    true,
  );
});

test("resident conversation store ignores persisted replay by default", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-persisted",
    type: "turn.started",
    source: {
      provider: "codex",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {},
  });
  assert.equal(store.snapshot("session-1").turns.length, 0);
  store.close();
});

test("resident conversation store emits bounded item deltas and preserves trimmed items", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus, { eventWindow: 2 });
  const started = eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started",
    source,
    payload: {},
  });
  const first = eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "timeline.item.added",
    source,
    payload: {
      item: { kind: "assistant_message", text: "first", messageId: "message-1", phase: "commentary" },
    },
  });
  const second = eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "timeline.item.added",
    source,
    payload: {
      item: { kind: "assistant_message", text: "second", messageId: "message-2", phase: "commentary" },
    },
  });
  const completed = eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed",
    source,
    payload: {},
  });

  assert.equal(store.deltaForSourceSeq(started.seq)?.revision, 1);
  assert.equal(store.deltaForSourceSeq(first.seq)?.upsertTurns[0]?.upsertItems.length, 1);
  assert.equal(store.deltaForSourceSeq(second.seq)?.upsertTurns[0]?.upsertItems.length, 1);
  assert.equal(store.deltaForSourceSeq(completed.seq)?.upsertTurns[0]?.upsertItems.length, 0);
  const snapshot = store.snapshot("session-1");
  assert.deepEqual(
    snapshot.turns[0]?.items.map((item) =>
      item.content.kind === "timeline" && "text" in item.content.item
        ? item.content.item.text
        : "",
    ),
    ["first", "second"],
  );
  assert.equal(snapshot.turns[0]?.status, "completed");
  assert.equal(snapshot.liveRevision, 4);
  store.close();
});

test("resident conversation projection is isolated from high-volume data-plane events", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  eventBus.publish({
    sessionId: "session-noisy",
    turnId: "turn-1",
    type: "turn.started",
    source,
    payload: {},
  });
  const before = store.snapshot("session-noisy");
  let lastDataPlaneSeq = 0;
  for (let index = 0; index < 10_000; index += 1) {
    const output = eventBus.publish({
      sessionId: "session-noisy",
      turnId: "turn-1",
      type: "process.output.appended",
      source,
      payload: {
        output: {
          itemId: "command-1",
          stream: "combined",
          sequence: index + 1,
          offsetBytes: index,
          data: "x",
          totalBytes: index + 1,
        },
      },
    });
    lastDataPlaneSeq = output.seq;
  }

  assert.deepEqual(store.snapshot("session-noisy"), before);
  assert.equal(store.deltaForSourceSeq(lastDataPlaneSeq), undefined);

  const semantic = eventBus.publish({
    sessionId: "session-noisy",
    turnId: "turn-1",
    type: "timeline.item.added",
    source,
    payload: {
      item: {
        kind: "assistant_message",
        text: "still responsive",
        messageId: "message-1",
        phase: "commentary",
      },
    },
  });
  assert.equal(
    store.deltaForSourceSeq(semantic.seq)?.upsertTurns[0]?.upsertItems.length,
    1,
  );
  assert.equal(store.snapshot("session-noisy").liveRevision, 2);
  store.close();
});

test("resident conversation store preserves turn file changes through lifecycle deltas", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started",
    source,
    payload: {},
  });
  const fileChanges = {
    files: [{ path: "src/main.ts", additions: 2, deletions: 1 }],
    totalAdditions: 2,
    totalDeletions: 1,
  };
  const updated = eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.file_changes.updated",
    source,
    payload: { fileChanges },
  });
  const completed = eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed",
    source,
    payload: {},
  });

  assert.deepEqual(
    store.deltaForSourceSeq(updated.seq)?.upsertTurns[0]?.turn.fileChanges,
    fileChanges,
  );
  assert.deepEqual(
    store.deltaForSourceSeq(completed.seq)?.upsertTurns[0]?.turn.fileChanges,
    fileChanges,
  );
  assert.deepEqual(store.snapshot("session-1").turns[0]?.fileChanges, fileChanges);
  store.close();
});

test("Codex persisted mirror emits canonical item deltas for the active turn", () => {
  const eventBus = new EventBus();
  const sessionStore = new SessionStore();
  const services = { eventBus, sessionStore, ptyHub: new PtyHub() };
  const sessionId = sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: "thread-1",
    launchSource: "web",
    cwd: "/workspace/demo",
    rootDir: "/workspace/demo",
    title: "Codex mirror",
  }).session.id;
  const store = new ConversationProjectionStore(eventBus, {
    eventFilter: (event) => event.source.channel === "structured_persisted",
  });
  const meta = {
    provider: "codex" as const,
    channel: "structured_persisted" as const,
    authority: "authoritative" as const,
  };
  const translationState = createCodexRolloutTranslationState({
    providerSessionId: "thread-1",
  });

  applyProviderActivity(services, sessionId, meta, {
    type: "turn_started",
    turnId: "turn-1",
  });
  translateCodexRolloutLine(
    {
      timestamp: "2026-07-11T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    },
    translationState,
  );
  const records = [
    {
      timestamp: "2026-07-11T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the repository" }],
      },
    },
    {
      timestamp: "2026-07-11T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Checking the implementation.",
        phase: "commentary",
      },
    },
    {
      timestamp: "2026-07-11T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Inspection complete." }],
        phase: "final_answer",
      },
    },
  ];
  const itemEvents = records.flatMap((record) =>
    translateCodexRolloutLine(record, translationState).flatMap((item) =>
      applyProviderActivity(services, sessionId, {
        ...meta,
        ...(item.ts ? { ts: item.ts } : {}),
      }, item.activity),
    ),
  );
  applyProviderActivity(services, sessionId, meta, {
    type: "turn_completed",
    turnId: "turn-1",
  });

  assert.equal(itemEvents.length, 3);
  assert.deepEqual(itemEvents.map((event) => event.turnId), ["turn-1", "turn-1", "turn-1"]);
  for (const event of itemEvents) {
    assert.equal(store.deltaForSourceSeq(event.seq)?.upsertTurns[0]?.upsertItems.length, 1);
  }
  const turn = store.snapshot(sessionId).turns[0];
  assert.equal(turn?.status, "completed");
  assert.deepEqual(
    turn?.items.map((item) =>
      item.content.kind === "timeline" && "text" in item.content.item
        ? item.content.item.text
        : "",
    ),
    ["Inspect the repository", "Checking the implementation.", "Inspection complete."],
  );
  assert.equal(
    turn?.items.find((item) => item.id === turn.finalAnswerItemId)?.role,
    "final",
  );
  store.close();
});

test("history cache expansion does not advance the live delta revision", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  const live = eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-live",
    type: "turn.started",
    source,
    payload: {},
  });
  assert.equal(store.deltaForSourceSeq(live.seq)?.baseRevision, 0);

  const older: ConversationProjection = {
    sessionId: "session-1",
    turns: [
      {
        id: "older-turn",
        provider: "codex",
        providerTurnId: "older-provider-turn",
        status: "completed",
        statusAuthority: "native",
        items: [],
        failedItemCount: 0,
        activities: [],
        revision: 1,
      },
    ],
    revision: 1,
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceEventCount: 1,
  };
  store.mergeProjection(older, { position: "older" });
  assert.equal(store.snapshot("session-1").liveRevision, 1);

  const final = eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-live",
    type: "turn.completed",
    source,
    payload: {},
  });
  const delta = store.deltaForSourceSeq(final.seq);
  assert.equal(delta?.baseRevision, 1);
  assert.equal(delta?.revision, 2);
  const turns = store.snapshot("session-1").turns;
  assert.equal(turns[0]?.id, "older-turn");
  assert.equal(turns[1]?.providerTurnId, "turn-live");
  store.close();
});

test("resident live projection overlays a history baseline without storing the baseline", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  eventBus.publish({
    sessionId: "session-1",
    turnId: "provider-turn-1",
    type: "timeline.item.added",
    source,
    payload: {
      item: {
        kind: "assistant_message",
        text: "live process",
        messageId: "process-1",
        phase: "commentary",
      },
    },
  });
  const baseline: ConversationProjection = {
    sessionId: "session-1",
    turns: [
      {
        id: "history-turn-1",
        provider: "codex",
        providerTurnId: "provider-turn-1",
        status: "completed",
        statusAuthority: "native",
        items: [
          {
            id: "final-1",
            turnId: "history-turn-1",
            role: "final",
            status: "completed",
            content: {
              kind: "timeline",
              item: {
                kind: "assistant_message",
                text: "history final",
                phase: "final_answer",
              },
            },
            source: {
              provider: "codex",
              channel: "structured_persisted",
              authority: "authoritative",
            },
            revision: 1,
          },
        ],
        finalAnswerItemId: "final-1",
        failedItemCount: 0,
        activities: [],
        revision: 1,
      },
    ],
    revision: 1,
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceEventCount: 1,
  };

  const overlaid = store.overlayLiveProjection(baseline);
  const overlaidSnapshot = store.overlayLiveSnapshot(baseline);
  assert.deepEqual(
    overlaid.turns[0]?.items.map((item) =>
      item.content.kind === "timeline" && "text" in item.content.item
        ? item.content.item.text
        : "",
    ),
    ["history final", "live process"],
  );
  assert.deepEqual(
    store.snapshot("session-1").turns[0]?.items.map((item) =>
      item.content.kind === "timeline" && "text" in item.content.item
        ? item.content.item.text
        : "",
    ),
    ["live process"],
  );
  assert.equal(overlaidSnapshot.liveRevision, 1);
  assert.deepEqual(overlaidSnapshot.turns, overlaid.turns);
  store.close();
});

test("resident live lifecycle overrides a stale terminal history snapshot", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  eventBus.publish({
    sessionId: "session-1",
    turnId: "provider-turn-1",
    type: "turn.started",
    source,
    payload: {},
  });
  eventBus.publish({
    sessionId: "session-1",
    turnId: "provider-turn-1",
    type: "timeline.item.added",
    source,
    payload: {
      item: {
        kind: "user_message",
        text: "current request",
        messageId: "user-1",
      },
    },
  });
  const baseline: ConversationProjection = {
    sessionId: "session-1",
    turns: [
      {
        id: "history-turn-1",
        provider: "codex",
        providerTurnId: "provider-turn-1",
        status: "interrupted",
        statusAuthority: "native",
        completedAt: "2026-07-11T00:00:01.000Z",
        error: { message: "stale interruption" },
        items: [],
        failedItemCount: 0,
        activities: [],
        revision: 10_000,
      },
    ],
    revision: 10_000,
    generatedAt: "2026-07-11T00:00:01.000Z",
    sourceEventCount: 1,
  };

  const overlaid = store.overlayLiveProjection(baseline);
  assert.equal(overlaid.turns.length, 1);
  assert.equal(overlaid.turns[0]?.providerTurnId, "provider-turn-1");
  assert.equal(overlaid.turns[0]?.status, "in_progress");
  assert.equal(overlaid.turns[0]?.statusAuthority, "native");
  assert.equal(overlaid.turns[0]?.completedAt, undefined);
  assert.equal(overlaid.turns[0]?.error, undefined);
  store.close();
});

test("resident overlay appends only turns after the latest history overlap", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  const makeTurn = (id: string) => ({
    id: `live-${id}`,
    provider: "codex" as const,
    providerTurnId: id,
    status: "completed" as const,
    statusAuthority: "native" as const,
    items: [],
    failedItemCount: 0,
    activities: [],
    revision: 1,
  });
  store.mergeProjection(
    {
      sessionId: "session-1",
      turns: [makeTurn("old"), makeTurn("overlap"), makeTurn("new")],
      revision: 1,
      generatedAt: "2026-07-11T00:00:00.000Z",
      sourceEventCount: 3,
    },
    { live: true },
  );
  const baseline: ConversationProjection = {
    sessionId: "session-1",
    turns: [{ ...makeTurn("overlap"), id: "history-overlap" }],
    revision: 1,
    generatedAt: "2026-07-11T00:00:00.000Z",
    sourceEventCount: 1,
  };

  const overlaid = store.overlayLiveSnapshot(baseline);
  assert.deepEqual(
    overlaid.turns.map((turn) => turn.providerTurnId),
    ["overlap", "new"],
  );
  store.close();
});

test("resident store bounds settled turns without dropping an active turn", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus, { maxResidentTurns: 2 });
  const turns = [
    {
      id: "settled-1",
      provider: "codex" as const,
      providerTurnId: "settled-1",
      status: "completed" as const,
      statusAuthority: "native" as const,
      items: [],
      failedItemCount: 0,
      activities: [],
      revision: 1,
    },
    {
      id: "active",
      provider: "codex" as const,
      providerTurnId: "active",
      status: "in_progress" as const,
      statusAuthority: "native" as const,
      items: [],
      failedItemCount: 0,
      activities: [],
      revision: 1,
    },
    {
      id: "settled-2",
      provider: "codex" as const,
      providerTurnId: "settled-2",
      status: "completed" as const,
      statusAuthority: "native" as const,
      items: [],
      failedItemCount: 0,
      activities: [],
      revision: 1,
    },
  ];
  store.mergeProjection(
    {
      sessionId: "session-1",
      turns,
      revision: 1,
      generatedAt: "2026-07-11T00:00:00.000Z",
      sourceEventCount: 3,
    },
    { live: true },
  );

  assert.deepEqual(
    store.snapshot("session-1").turns.map((turn) => turn.id),
    ["active", "settled-2"],
  );
  store.close();
});

test("explicit commentary stays process content when live and history items merge", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  const live: ConversationProjection = {
    sessionId: "session-1",
    turns: [
      {
        id: "live-turn-1",
        provider: "codex",
        providerTurnId: "provider-turn-1",
        status: "completed",
        statusAuthority: "native",
        items: [
          {
            id: "message-1",
            turnId: "live-turn-1",
            role: "process",
            status: "completed",
            content: {
              kind: "timeline",
              item: {
                kind: "assistant_message",
                text: "working note",
                phase: "commentary",
              },
            },
            source,
            revision: 2,
          },
          {
            id: "message-2",
            turnId: "live-turn-1",
            role: "final",
            status: "completed",
            content: {
              kind: "timeline",
              item: {
                kind: "assistant_message",
                text: "final answer",
                phase: "final_answer",
              },
            },
            source,
            revision: 3,
          },
        ],
        finalAnswerItemId: "message-2",
        failedItemCount: 0,
        activities: [],
        revision: 3,
      },
    ],
    revision: 3,
    generatedAt: "2026-07-11T00:00:03.000Z",
    sourceEventCount: 3,
  };
  store.mergeProjection(live, { live: true });
  const baseline: ConversationProjection = {
    sessionId: "session-1",
    turns: [
      {
        ...live.turns[0]!,
        id: "history-turn-1",
        items: [
          {
            ...live.turns[0]!.items[0]!,
            turnId: "history-turn-1",
            role: "final",
            content: {
              kind: "timeline",
              item: { kind: "assistant_message", text: "working note" },
            },
            revision: 100,
          },
        ],
        finalAnswerItemId: "message-1",
        revision: 100,
      },
    ],
    revision: 100,
    generatedAt: "2026-07-11T00:00:04.000Z",
    sourceEventCount: 1,
  };

  const overlaid = store.overlayLiveProjection(baseline);
  assert.equal(overlaid.turns.length, 1);
  assert.equal(overlaid.turns[0]?.items.find((item) => item.id === "message-1")?.role, "process");
  assert.equal(overlaid.turns[0]?.finalAnswerItemId, "message-2");
  store.close();
});

test("resident conversation store does not regress a terminal turn after its event leaves the window", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus, { eventWindow: 1 });
  eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed",
    source,
    payload: {},
  });
  eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "timeline.item.updated",
    source,
    payload: {
      item: { kind: "assistant_message", text: "late", messageId: "late", phase: "commentary" },
    },
  });

  const turn = store.snapshot("session-1").turns[0];
  assert.equal(turn?.status, "completed");
  assert.equal(turn?.items.length, 1);
  store.close();
});

test("resident conversation store releases projections when a runtime session closes", () => {
  const eventBus = new EventBus();
  const store = new ConversationProjectionStore(eventBus);
  eventBus.publish({
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started",
    source,
    payload: {},
  });
  assert.equal(store.snapshot("session-1").turns.length, 1);

  eventBus.publish({
    sessionId: "session-1",
    type: "session.closed",
    source,
    payload: {},
  });

  assert.equal(store.snapshot("session-1").turns.length, 0);
  assert.equal(store.snapshot("session-1").liveRevision, 0);
  store.close();
});
