import { createHash } from "node:crypto";
import type {
  ProviderKind,
  TimelineIdentity,
  TimelineIdentityConfidence,
  TimelineIdentityOrigin,
  TimelineSourceCursor,
} from "@rah/runtime-protocol";

export interface CreateTimelineIdentityParams {
  provider: ProviderKind;
  providerSessionId?: string;
  turnKey: string;
  itemKind: string;
  itemKey: string;
  origin: TimelineIdentityOrigin;
  sourceCursor?: TimelineSourceCursor;
  contentHash?: string;
  confidence?: TimelineIdentityConfidence;
}

export function createTimelineIdentity(params: CreateTimelineIdentityParams): TimelineIdentity {
  const canonicalTurnId = stableTimelineHash([
    "rah.timeline.turn.v2",
    params.provider,
    params.providerSessionId ?? "",
    params.turnKey,
  ]);
  const canonicalItemId = stableTimelineHash([
    "rah.timeline.item.v2",
    params.provider,
    params.providerSessionId ?? "",
    params.turnKey,
    params.itemKind,
    params.itemKey,
  ]);
  const identity: TimelineIdentity = {
    canonicalItemId,
    canonicalTurnId,
    provider: params.provider,
    turnKey: params.turnKey,
    itemKind: params.itemKind,
    itemKey: params.itemKey,
    origin: params.origin,
    confidence: params.confidence ?? "derived",
  };
  if (params.providerSessionId !== undefined) {
    identity.providerSessionId = params.providerSessionId;
  }
  if (params.sourceCursor !== undefined) {
    identity.sourceCursor = params.sourceCursor;
  }
  if (params.contentHash !== undefined) {
    identity.contentHash = params.contentHash;
  }
  return identity;
}

export function stableTimelineHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
