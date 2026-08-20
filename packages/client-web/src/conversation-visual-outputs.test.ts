import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  ConversationOutputProjection,
  ConversationTurnProjection,
} from "@rah/runtime-protocol";
import {
  conversationVisualOutputs,
  MAX_INLINE_VISUAL_OUTPUTS,
} from "./conversation-visual-outputs";

function output(
  id: string,
  overrides: Partial<ConversationOutputProjection> = {},
): ConversationOutputProjection {
  return {
    id,
    kind: "image",
    label: `${id}.png`,
    path: `/workspace/${id}.png`,
    activity: "generated",
    confidence: "authoritative",
    sourceItemIds: [`tool-${id}`],
    ...overrides,
  };
}

function turn(
  outputs: ConversationOutputProjection[],
  status: ConversationTurnProjection["status"] = "completed",
): Pick<ConversationTurnProjection, "finalAnswerItemId" | "outputs" | "status"> {
  return { status, finalAnswerItemId: "final", outputs };
}

describe("conversation visual outputs", () => {
  test("keeps non-images in Inspector and suppresses already embedded final images", () => {
    const visuals = conversationVisualOutputs(
      turn([
        output("native"),
        output("embedded", { sourceItemIds: ["final"] }),
        output("linked", {
          confidence: "inferred",
          sourceItemIds: ["final"],
        }),
        output("report", {
          kind: "file",
          label: "report.md",
          path: "/workspace/report.md",
        }),
      ]),
    );

    assert.deepEqual(visuals.outputs.map((item) => item.id), ["native", "linked"]);
    assert.equal(visuals.omittedCount, 0);
  });

  test("hides unfinished images and bounds the inline gallery", () => {
    assert.deepEqual(conversationVisualOutputs(turn([output("pending")], "in_progress")), {
      outputs: [],
      omittedCount: 0,
    });

    const outputs = Array.from(
      { length: MAX_INLINE_VISUAL_OUTPUTS + 3 },
      (_, index) => output(`image-${index}`),
    );
    const visuals = conversationVisualOutputs(turn(outputs));
    assert.equal(visuals.outputs.length, MAX_INLINE_VISUAL_OUTPUTS);
    assert.equal(visuals.omittedCount, 3);
  });
});
