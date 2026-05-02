import type { TimelineIdentity, TimelineItem } from "@rah/runtime-protocol";
import { createTimelineIdentity } from "./timeline-identity";

type KimiTimelineItemKind = Extract<
  TimelineItem,
  { kind: "user_message" | "assistant_message" | "reasoning" | "plan" }
>["kind"];

export function createKimiTimelineIdentity(args: {
  providerSessionId: string;
  turnIndex: number;
  itemKind: KimiTimelineItemKind;
  itemIndex: number;
  origin: "live" | "history";
  confidence?: TimelineIdentity["confidence"];
}): TimelineIdentity {
  return createTimelineIdentity({
    provider: "kimi",
    providerSessionId: args.providerSessionId,
    turnKey: `turn:${args.turnIndex}`,
    itemKind: args.itemKind,
    itemKey: `item:${args.itemIndex}`,
    origin: args.origin,
    confidence: args.confidence ?? "derived",
    sourceCursor: {
      turnIndex: args.turnIndex,
      itemIndex: args.itemIndex,
    },
  });
}
