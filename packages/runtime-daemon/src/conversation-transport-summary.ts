import type {
  ConversationItemProjection,
  ConversationTurnProjection,
} from "@rah/runtime-protocol";

const SUMMARY_ITEM_BUDGET_BYTES = 64 * 1024;
const RECENT_PROCESS_ITEM_LIMIT = 24;

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isRequiredSummaryItem(
  turn: ConversationTurnProjection,
  item: ConversationItemProjection,
): boolean {
  if (
    item.role !== "process" ||
    item.id === turn.finalAnswerItemId ||
    item.status === "pending" ||
    item.status === "running" ||
    item.status === "failed" ||
    item.status === "interrupted"
  ) {
    return true;
  }
  if (item.content.kind === "permission") {
    return true;
  }
  if (item.content.kind !== "timeline") {
    return false;
  }
  switch (item.content.item.kind) {
    case "user_message":
    case "system":
    case "error":
    case "retry":
    case "side_question":
    case "attachment":
      return true;
    case "assistant_message":
      return item.content.item.phase === "final_answer";
    default:
      return false;
  }
}

function isSemanticProcessItem(item: ConversationItemProjection): boolean {
  if (item.content.kind !== "timeline") {
    return false;
  }
  switch (item.content.item.kind) {
    case "assistant_message":
    case "reasoning":
    case "plan":
    case "step":
    case "todo":
      return true;
    default:
      return false;
  }
}

function addRecentItemsWithinBudget(args: {
  candidates: Array<{ item: ConversationItemProjection; index: number }>;
  selectedIndexes: Set<number>;
  currentBytes: number;
  maxItems?: number;
}): number {
  let bytes = args.currentBytes;
  let added = 0;
  for (let index = args.candidates.length - 1; index >= 0; index -= 1) {
    if (args.maxItems !== undefined && added >= args.maxItems) {
      break;
    }
    const candidate = args.candidates[index];
    if (!candidate || args.selectedIndexes.has(candidate.index)) {
      continue;
    }
    const itemBytes = serializedBytes(candidate.item);
    if (bytes + itemBytes > SUMMARY_ITEM_BUDGET_BYTES) {
      continue;
    }
    args.selectedIndexes.add(candidate.index);
    bytes += itemBytes;
    added += 1;
  }
  return bytes;
}

/**
 * Bounds the initial conversation payload without mutating the resident live
 * projection. Full process evidence remains available from turn/item detail.
 */
export function summarizeConversationTurnForTransport(
  turn: ConversationTurnProjection,
): ConversationTurnProjection {
  const fullItemsBytes = serializedBytes(turn.items);
  if (fullItemsBytes <= SUMMARY_ITEM_BUDGET_BYTES) {
    return turn;
  }

  const selectedIndexes = new Set<number>();
  let selectedBytes = 0;
  const semanticCandidates: Array<{ item: ConversationItemProjection; index: number }> = [];
  const processCandidates: Array<{ item: ConversationItemProjection; index: number }> = [];

  turn.items.forEach((item, index) => {
    if (isRequiredSummaryItem(turn, item)) {
      selectedIndexes.add(index);
      selectedBytes += serializedBytes(item);
      return;
    }
    const candidate = { item, index };
    if (isSemanticProcessItem(item)) {
      semanticCandidates.push(candidate);
    } else if (
      item.content.kind !== "timeline" ||
      item.content.item.kind !== "compaction"
    ) {
      processCandidates.push(candidate);
    }
  });

  selectedBytes = addRecentItemsWithinBudget({
    candidates: semanticCandidates,
    selectedIndexes,
    currentBytes: selectedBytes,
  });
  addRecentItemsWithinBudget({
    candidates: processCandidates,
    selectedIndexes,
    currentBytes: selectedBytes,
    maxItems: RECENT_PROCESS_ITEM_LIMIT,
  });

  return {
    ...turn,
    items: turn.items.filter((_item, index) => selectedIndexes.has(index)),
    itemsView: "summary",
  };
}

export function summarizeConversationTurnsForTransport(
  turns: ConversationTurnProjection[],
): ConversationTurnProjection[] {
  return turns.map(summarizeConversationTurnForTransport);
}
