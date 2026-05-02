import type {
  EventAuthority,
  EventChannel,
  ProviderKind,
  TimelineIdentity,
  TimelineItem,
} from "@rah/runtime-protocol";

const IDENTITY_EXPECTED_KINDS = new Set<TimelineItem["kind"]>([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
]);
const MAX_IDENTITY_SNAPSHOTS_PER_SESSION = 20_000;

export type TimelineIdentityTelemetryCode =
  | "timeline.identity.missing"
  | "timeline.identity.mismatch"
  | "timeline.identity.collision";

export interface TimelineIdentityTelemetryWarning {
  code: TimelineIdentityTelemetryCode;
  sessionId: string;
  provider: ProviderKind;
  channel: EventChannel;
  authority: EventAuthority;
  activityType: "timeline_item" | "timeline_item_updated";
  itemKind: TimelineItem["kind"];
  turnId?: string;
  canonicalItemId?: string;
  details?: Record<string, unknown>;
}

interface TimelineIdentitySnapshot {
  canonicalItemId: string;
  canonicalTurnId: string;
  provider: ProviderKind;
  providerSessionId?: string;
  itemKind: string;
  itemKey: string;
}

interface TelemetryState {
  identitySnapshotsBySession: Map<string, Map<string, TimelineIdentitySnapshot>>;
  warnedCollisionKeys: Set<string>;
}

let statesByServices = new WeakMap<object, TelemetryState>();
let warnedMissingKeys = new Set<string>();
let warnedMismatchKeys = new Set<string>();
let warnSink = defaultWarnSink;

export function recordTimelineIdentityTelemetry(
  services: object,
  params: {
    sessionId: string;
    provider: ProviderKind;
    channel?: EventChannel | undefined;
    authority?: EventAuthority | undefined;
    activityType: "timeline_item" | "timeline_item_updated";
    item: TimelineItem;
    turnId?: string | undefined;
    identity?: TimelineIdentity | undefined;
  },
): void {
  const channel = params.channel ?? "structured_live";
  const authority = params.authority ?? "derived";

  if (params.identity === undefined) {
    if (!shouldWarnForMissingIdentity({
      provider: params.provider,
      channel,
      authority,
      item: params.item,
      turnId: params.turnId,
    })) {
      return;
    }
    const warningKey = [
      params.provider,
      channel,
      authority,
      params.activityType,
      params.item.kind,
    ].join(":");
    if (warnedMissingKeys.has(warningKey)) {
      return;
    }
    warnedMissingKeys.add(warningKey);
    warnSink({
      code: "timeline.identity.missing",
      sessionId: params.sessionId,
      provider: params.provider,
      channel,
      authority,
      activityType: params.activityType,
      itemKind: params.item.kind,
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      details: {
        reason: "High-value timeline items need a canonical identity before reaching the UI.",
      },
    });
    return;
  }

  recordIdentityMismatch({
    sessionId: params.sessionId,
    provider: params.provider,
    channel,
    authority,
    activityType: params.activityType,
    itemKind: params.item.kind,
    turnId: params.turnId,
    identity: params.identity,
  });
  recordIdentityCollision(services, {
    sessionId: params.sessionId,
    provider: params.provider,
    channel,
    authority,
    activityType: params.activityType,
    itemKind: params.item.kind,
    turnId: params.turnId,
    identity: params.identity,
  });
}

function shouldWarnForMissingIdentity(params: {
  provider: ProviderKind;
  channel: EventChannel;
  authority: EventAuthority;
  item: TimelineItem;
  turnId?: string | undefined;
}): boolean {
  if (!IDENTITY_EXPECTED_KINDS.has(params.item.kind)) {
    return false;
  }

  if (params.turnId === undefined && readTimelineMessageId(params.item) === undefined) {
    return false;
  }

  // Web-owned live input echoes often do not have a provider-native message id
  // yet. Giving them a fake canonical id would block later history reconciliation
  // when the provider emits the real item, so keep them identity-less.
  if (
    params.item.kind === "user_message" &&
    params.channel === "structured_live" &&
    readTimelineMessageId(params.item) === undefined
  ) {
    return false;
  }

  // Gemini live streams do not expose stable provider-native item ids for all
  // message parts. Keep those items identity-less instead of manufacturing ids
  // that cannot reconcile with Gemini's stored history message ids later.
  if (
    params.provider === "gemini" &&
    params.channel === "structured_live" &&
    readTimelineMessageId(params.item) === undefined
  ) {
    return false;
  }

  return true;
}

export function setTimelineIdentityTelemetryWarnSinkForTests(
  sink: ((warning: TimelineIdentityTelemetryWarning) => void) | undefined,
): void {
  warnSink = sink ?? defaultWarnSink;
}

export function resetTimelineIdentityTelemetryForTests(): void {
  statesByServices = new WeakMap<object, TelemetryState>();
  warnedMissingKeys = new Set<string>();
  warnedMismatchKeys = new Set<string>();
  warnSink = defaultWarnSink;
}

function recordIdentityMismatch(params: {
  sessionId: string;
  provider: ProviderKind;
  channel: EventChannel;
  authority: EventAuthority;
  activityType: "timeline_item" | "timeline_item_updated";
  itemKind: TimelineItem["kind"];
  turnId?: string | undefined;
  identity: TimelineIdentity;
}) {
  const mismatches: Record<string, unknown> = {};
  if (params.identity.provider !== params.provider) {
    mismatches.provider = {
      expected: params.provider,
      actual: params.identity.provider,
    };
  }
  if (params.identity.itemKind !== params.itemKind) {
    mismatches.itemKind = {
      expected: params.itemKind,
      actual: params.identity.itemKind,
    };
  }
  if (Object.keys(mismatches).length === 0) {
    return;
  }

  const warningKey = [
    params.identity.canonicalItemId,
    params.provider,
    params.itemKind,
    JSON.stringify(mismatches),
  ].join(":");
  if (warnedMismatchKeys.has(warningKey)) {
    return;
  }
  warnedMismatchKeys.add(warningKey);
  warnSink({
    code: "timeline.identity.mismatch",
    sessionId: params.sessionId,
    provider: params.provider,
    channel: params.channel,
    authority: params.authority,
    activityType: params.activityType,
    itemKind: params.itemKind,
    ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
    canonicalItemId: params.identity.canonicalItemId,
    details: mismatches,
  });
}

function recordIdentityCollision(
  services: object,
  params: {
    sessionId: string;
    provider: ProviderKind;
    channel: EventChannel;
    authority: EventAuthority;
    activityType: "timeline_item" | "timeline_item_updated";
    itemKind: TimelineItem["kind"];
    turnId?: string | undefined;
    identity: TimelineIdentity;
  },
) {
  const state = stateForServices(services);
  let snapshots = state.identitySnapshotsBySession.get(params.sessionId);
  if (snapshots === undefined) {
    snapshots = new Map<string, TimelineIdentitySnapshot>();
    state.identitySnapshotsBySession.set(params.sessionId, snapshots);
  }

  const snapshot = snapshotIdentity(params.identity);
  const existing = snapshots.get(snapshot.canonicalItemId);
  if (existing === undefined) {
    snapshots.set(snapshot.canonicalItemId, snapshot);
    pruneOldestSnapshots(snapshots);
    return;
  }

  const conflicts = identityConflicts(existing, snapshot);
  if (Object.keys(conflicts).length === 0) {
    return;
  }

  const warningKey = `${params.sessionId}:${snapshot.canonicalItemId}`;
  if (state.warnedCollisionKeys.has(warningKey)) {
    return;
  }
  state.warnedCollisionKeys.add(warningKey);
  warnSink({
    code: "timeline.identity.collision",
    sessionId: params.sessionId,
    provider: params.provider,
    channel: params.channel,
    authority: params.authority,
    activityType: params.activityType,
    itemKind: params.itemKind,
    ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
    canonicalItemId: snapshot.canonicalItemId,
    details: conflicts,
  });
}

function readTimelineMessageId(item: TimelineItem): string | undefined {
  if (item.kind === "user_message" || item.kind === "assistant_message") {
    return item.messageId;
  }
  return undefined;
}

function pruneOldestSnapshots(snapshots: Map<string, TimelineIdentitySnapshot>): void {
  while (snapshots.size > MAX_IDENTITY_SNAPSHOTS_PER_SESSION) {
    const oldestKey = snapshots.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      return;
    }
    snapshots.delete(oldestKey);
  }
}

function stateForServices(services: object): TelemetryState {
  let state = statesByServices.get(services);
  if (state === undefined) {
    state = {
      identitySnapshotsBySession: new Map(),
      warnedCollisionKeys: new Set(),
    };
    statesByServices.set(services, state);
  }
  return state;
}

function snapshotIdentity(identity: TimelineIdentity): TimelineIdentitySnapshot {
  const snapshot: TimelineIdentitySnapshot = {
    canonicalItemId: identity.canonicalItemId,
    canonicalTurnId: identity.canonicalTurnId,
    provider: identity.provider,
    itemKind: identity.itemKind,
    itemKey: identity.itemKey,
  };
  if (identity.providerSessionId !== undefined) {
    snapshot.providerSessionId = identity.providerSessionId;
  }
  return snapshot;
}

function identityConflicts(
  existing: TimelineIdentitySnapshot,
  incoming: TimelineIdentitySnapshot,
): Record<string, unknown> {
  const conflicts: Record<string, unknown> = {};
  for (const key of [
    "canonicalTurnId",
    "provider",
    "providerSessionId",
    "itemKind",
    "itemKey",
  ] as const) {
    if (existing[key] !== incoming[key]) {
      conflicts[key] = {
        existing: existing[key],
        incoming: incoming[key],
      };
    }
  }
  return conflicts;
}

function defaultWarnSink(warning: TimelineIdentityTelemetryWarning): void {
  console.warn(`[rah] ${warning.code}`, warning);
}
