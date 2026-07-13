import type {
  ConversationOutputProjection,
  ConversationSourceProjection,
  ConversationTurnProjection,
} from "@rah/runtime-protocol";

function earliest(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function latest(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function mergedSourceItemIds(left: readonly string[], right: readonly string[]): string[] {
  const ids = [...left];
  for (const id of right) {
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function mergeConversationOutputs(
  current: readonly ConversationOutputProjection[] = [],
  incoming: readonly ConversationOutputProjection[] = [],
): ConversationOutputProjection[] {
  const byId = new Map(current.map((output) => [output.id, output]));
  for (const output of incoming) {
    const existing = byId.get(output.id);
    if (!existing) {
      byId.set(output.id, output);
      continue;
    }
    const firstSeenAt = earliest(existing.firstSeenAt, output.firstSeenAt);
    const lastSeenAt = latest(existing.lastSeenAt, output.lastSeenAt);
    byId.set(output.id, {
      ...existing,
      ...output,
      confidence:
        existing.confidence === "authoritative" || output.confidence === "authoritative"
          ? "authoritative"
          : "inferred",
      sourceItemIds: mergedSourceItemIds(existing.sourceItemIds, output.sourceItemIds),
      ...(firstSeenAt ? { firstSeenAt } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
    });
  }
  return [...byId.values()].sort((left, right) =>
    (left.firstSeenAt ?? "").localeCompare(right.firstSeenAt ?? "") ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id),
  );
}

export function mergeConversationSources(
  current: readonly ConversationSourceProjection[] = [],
  incoming: readonly ConversationSourceProjection[] = [],
): ConversationSourceProjection[] {
  const byId = new Map(current.map((source) => [source.id, source]));
  for (const source of incoming) {
    const existing = byId.get(source.id);
    if (!existing) {
      byId.set(source.id, source);
      continue;
    }
    const activities = [...existing.activities];
    for (const activity of source.activities) {
      if (!activities.includes(activity)) {
        activities.push(activity);
      }
    }
    const firstSeenAt = earliest(existing.firstSeenAt, source.firstSeenAt);
    const lastSeenAt = latest(existing.lastSeenAt, source.lastSeenAt);
    byId.set(source.id, {
      ...existing,
      ...source,
      activities,
      confidence:
        existing.confidence === "authoritative" || source.confidence === "authoritative"
          ? "authoritative"
          : "inferred",
      sourceItemIds: mergedSourceItemIds(existing.sourceItemIds, source.sourceItemIds),
      ...(firstSeenAt ? { firstSeenAt } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
    });
  }
  return [...byId.values()].sort((left, right) =>
    (left.firstSeenAt ?? "").localeCompare(right.firstSeenAt ?? "") ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id),
  );
}

export function collectConversationResources(turns: readonly ConversationTurnProjection[]): {
  outputs: ConversationOutputProjection[];
  sources: ConversationSourceProjection[];
} {
  let outputs: ConversationOutputProjection[] = [];
  let sources: ConversationSourceProjection[] = [];
  for (const turn of turns) {
    outputs = mergeConversationOutputs(outputs, turn.outputs);
    sources = mergeConversationSources(sources, turn.sources);
  }
  return { outputs, sources };
}
