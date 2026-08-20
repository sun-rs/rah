import type {
  ConversationOutputProjection,
  ConversationTurnProjection,
} from "@rah/runtime-protocol";

export const MAX_INLINE_VISUAL_OUTPUTS = 8;

export type ConversationVisualOutputs = {
  outputs: readonly ConversationOutputProjection[];
  omittedCount: number;
};

function isEmbeddedFinalImage(
  output: ConversationOutputProjection,
  finalAnswerItemId: string | undefined,
): boolean {
  return Boolean(
    finalAnswerItemId &&
      output.confidence === "authoritative" &&
      output.sourceItemIds.includes(finalAnswerItemId),
  );
}

/**
 * Chat previews only visual deliverables that are not already embedded by the
 * final Markdown renderer. Other output kinds remain owned by Inspector.
 */
export function conversationVisualOutputs(
  turn: Pick<
    ConversationTurnProjection,
    "finalAnswerItemId" | "outputs" | "status"
  >,
  fallbackFinalAnswerItemId?: string,
): ConversationVisualOutputs {
  if (turn.status === "in_progress") {
    return { outputs: [], omittedCount: 0 };
  }
  const finalAnswerItemId = turn.finalAnswerItemId ?? fallbackFinalAnswerItemId;
  const visualOutputs = (turn.outputs ?? []).filter(
    (output) =>
      output.kind === "image" &&
      Boolean(output.path || output.url) &&
      !isEmbeddedFinalImage(output, finalAnswerItemId),
  );
  return {
    outputs: visualOutputs.slice(0, MAX_INLINE_VISUAL_OUTPUTS),
    omittedCount: Math.max(0, visualOutputs.length - MAX_INLINE_VISUAL_OUTPUTS),
  };
}
