import type {
  ConversationProjection,
  RahEvent,
} from "@rah/runtime-protocol";
import { IncrementalConversationProjector } from "./incremental-conversation-projector";

export interface ProjectConversationOptions {
  /**
   * The source is known to be quiescent (for example, a stopped Claude JSONL
   * session). This permits the final derived turn to close without inventing a
   * live completion event.
   */
  assumeSettled?: boolean;
  partial?: boolean;
  generatedAt?: string;
}

/**
 * One-shot projection for persisted history.
 *
 * Live projection uses the same state machine incrementally, so persisted and
 * resident conversations cannot silently develop different semantics.
 */
export function projectConversation(
  sessionId: string,
  inputEvents: readonly RahEvent[],
  options: ProjectConversationOptions = {},
): ConversationProjection {
  const projector = new IncrementalConversationProjector(sessionId);
  const events = [...inputEvents]
    .filter((event) => event.sessionId === sessionId)
    .sort((left, right) => left.seq - right.seq || left.ts.localeCompare(right.ts));
  for (const event of events) {
    projector.apply(event);
  }
  return projector.projection(options);
}
