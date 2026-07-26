import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  composeConversationProjectionDeltas,
  type ConversationItemProjection,
  type ConversationProjectionDelta,
  type ConversationTurnStateProjection,
} from "./conversation";

function turn(id: string, revision: number): ConversationTurnStateProjection {
  return {
    id,
    provider: "codex",
    status: "in_progress",
    statusAuthority: "native",
    activities: [],
    failedItemCount: 0,
    revision,
  };
}

function item(id: string, turnId: string, revision: number): ConversationItemProjection {
  return {
    id,
    turnId,
    role: "process",
    status: "running",
    content: {
      kind: "timeline",
      item: { kind: "reasoning", text: `${id}-${revision}` },
    },
    source: {
      provider: "codex",
      channel: "structured_live",
      authority: "authoritative",
    },
    revision,
  };
}

describe("conversation projection delta composition", () => {
  test("collapses contiguous revisions while preserving removals and latest state", () => {
    const deltas: ConversationProjectionDelta[] = [
      {
        sessionId: "session-1",
        baseRevision: 0,
        revision: 1,
        sourceSeq: 10,
        upsertTurns: [{
          turn: turn("turn-1", 1),
          upsertItems: [
            item("keep", "turn-1", 1),
            item("remove", "turn-1", 1),
          ],
        }],
      },
      {
        sessionId: "session-1",
        baseRevision: 1,
        revision: 2,
        sourceSeq: 11,
        upsertTurns: [{
          turn: turn("turn-1", 2),
          upsertItems: [item("keep", "turn-1", 2)],
          removeItemIds: ["remove"],
        }],
      },
      {
        sessionId: "session-1",
        baseRevision: 2,
        revision: 3,
        sourceSeq: 12,
        upsertTurns: [{
          turn: turn("turn-2", 1),
          upsertItems: [item("second", "turn-2", 1)],
        }],
        removeTurnIds: ["turn-old"],
      },
    ];

    const [composed] = composeConversationProjectionDeltas(deltas);
    assert.equal(composed?.baseRevision, 0);
    assert.equal(composed?.revision, 3);
    assert.equal(composed?.sourceSeq, 12);
    assert.deepEqual(composed?.removeTurnIds, ["turn-old"]);
    assert.deepEqual(
      composed?.upsertTurns.map((entry) => ({
        turnId: entry.turn.id,
        revision: entry.turn.revision,
        items: entry.upsertItems.map((value) => value.id),
        removed: entry.removeItemIds,
      })),
      [
        {
          turnId: "turn-1",
          revision: 2,
          items: ["keep"],
          removed: ["remove"],
        },
        {
          turnId: "turn-2",
          revision: 1,
          items: ["second"],
          removed: undefined,
        },
      ],
    );
  });

  test("does not bridge a missing revision and keeps the latest duplicate", () => {
    const make = (
      baseRevision: number,
      revision: number,
      sourceSeq: number,
    ): ConversationProjectionDelta => ({
      sessionId: "session-1",
      baseRevision,
      revision,
      sourceSeq,
      upsertTurns: [],
    });

    const composed = composeConversationProjectionDeltas([
      make(0, 1, 1),
      make(0, 1, 2),
      make(4, 5, 5),
    ]);

    assert.deepEqual(
      composed.map((delta) => [delta.baseRevision, delta.revision, delta.sourceSeq]),
      [
        [0, 1, 2],
        [4, 5, 5],
      ],
    );
  });
});
