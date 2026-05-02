import type { TimelineIdentity, TimelineItem } from "@rah/runtime-protocol";
import { createTimelineIdentity } from "./timeline-identity";

type CodexTimelineItemKind = Extract<
  TimelineItem,
  { kind: "user_message" | "assistant_message" | "reasoning" | "plan" | "system" | "compaction" }
>["kind"];

export function createCodexTimelineIdentity(args: {
  providerSessionId?: string | undefined;
  turnId: string;
  itemKind: CodexTimelineItemKind;
  itemIndex: number;
  origin: "live" | "history";
  providerEventId?: string;
  providerMessageId?: string;
  confidence?: TimelineIdentity["confidence"];
}): TimelineIdentity {
  return createTimelineIdentity({
    provider: "codex",
    ...(args.providerSessionId !== undefined ? { providerSessionId: args.providerSessionId } : {}),
    turnKey: `turn:${args.turnId}`,
    itemKind: args.itemKind,
    itemKey: `item:${args.itemIndex}`,
    origin: args.origin,
    confidence: args.confidence ?? "derived",
    sourceCursor: {
      itemIndex: args.itemIndex,
      ...(args.providerEventId !== undefined ? { providerEventId: args.providerEventId } : {}),
      ...(args.providerMessageId !== undefined ? { providerMessageId: args.providerMessageId } : {}),
    },
  });
}
