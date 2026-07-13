import type {
  ConversationItemProjection,
  ConversationOutputActivity,
  ConversationOutputProjection,
  ConversationSourceActivity,
  ConversationSourceProjection,
  ToolCallArtifact,
} from "@rah/runtime-protocol";
import { stableTimelineHash } from "./timeline-identity";

const OUTPUT_OBSERVATION_ACTIVITY = new Map<string, ConversationOutputActivity>([
  ["file.write", "written"],
  ["file.edit", "updated"],
  ["patch.apply", "updated"],
  ["git.apply", "updated"],
]);
const SOURCE_OBSERVATION_ACTIVITY = new Map<string, ConversationSourceActivity>([
  ["file.read", "read"],
  ["media.read", "read"],
  ["file.list", "searched"],
  ["file.search", "searched"],
  ["workspace.scan", "searched"],
  ["web.search", "searched"],
  ["web.fetch", "fetched"],
]);
const OUTPUT_TOOL_ACTIVITY = new Map<string, ConversationOutputActivity>([
  ["file_write", "written"],
  ["file_edit", "updated"],
  ["patch", "updated"],
  ["notebook", "generated"],
  ["media", "generated"],
  ["preview", "generated"],
]);
const SOURCE_TOOL_ACTIVITY = new Map<string, ConversationSourceActivity>([
  ["file_read", "read"],
  ["search", "searched"],
  ["web_search", "searched"],
  ["fetch", "fetched"],
  ["web_fetch", "fetched"],
  ["browser", "fetched"],
]);
const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

type ResourceLocation = {
  kind: "file" | "image" | "url";
  label: string;
  path?: string;
  url?: string;
  mimeType?: string;
};
type OutputCandidate = ResourceLocation & {
  activity: ConversationOutputActivity;
  confidence: ConversationOutputProjection["confidence"];
  firstSeenAt?: string;
  lastSeenAt?: string;
};
type SourceCandidate = ResourceLocation & {
  activities: ConversationSourceActivity[];
  confidence: ConversationSourceProjection["confidence"];
  firstSeenAt?: string;
  lastSeenAt?: string;
};

function normalizePath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return !normalized || normalized === "." || normalized === "/dev/null"
    ? undefined
    : normalized;
}

function normalizeUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function pathLocation(value: string, mimeType?: string): ResourceLocation | undefined {
  const path = normalizePath(value);
  if (!path) return undefined;
  const label = path.slice(path.lastIndexOf("/") + 1) || path;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return {
    kind: IMAGE_EXTENSIONS.has(extension) ? "image" : "file",
    label,
    path,
    ...(mimeType ? { mimeType } : {}),
  };
}

function urlLocation(value: string, kind: "url" | "image" = "url"): ResourceLocation | undefined {
  const url = normalizeUrl(value);
  if (!url) return undefined;
  return {
    kind,
    label: new URL(url).hostname || url,
    url,
  };
}

function artifactLocations(artifacts: readonly ToolCallArtifact[]): ResourceLocation[] {
  const locations: ResourceLocation[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind === "file_refs") {
      for (const file of artifact.files) {
        const location = pathLocation(file);
        if (location) locations.push(location);
      }
    } else if (artifact.kind === "urls") {
      for (const url of artifact.urls) {
        const location = urlLocation(url);
        if (location) locations.push(location);
      }
    } else if (artifact.kind === "image") {
      const path = artifact.path ? pathLocation(artifact.path) : undefined;
      const url = artifact.url ? urlLocation(artifact.url, "image") : undefined;
      if (path) locations.push({ ...path, kind: "image" });
      if (url) locations.push(url);
    }
  }
  return locations;
}

function subjectLocations(subject: {
  files?: string[];
  urls?: string[];
} | undefined): ResourceLocation[] {
  if (!subject) return [];
  return [
    ...(subject.files ?? []).map((file) => pathLocation(file)),
    ...(subject.urls ?? []).map((url) => urlLocation(url)),
  ].filter((location): location is ResourceLocation => location !== undefined);
}

function itemTimes(item: ConversationItemProjection): {
  firstSeenAt?: string;
  lastSeenAt?: string;
} {
  const timestamp = item.completedAt ?? item.startedAt;
  return timestamp ? { firstSeenAt: timestamp, lastSeenAt: timestamp } : {};
}

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

function appendUnique<T>(current: readonly T[], incoming: readonly T[]): T[] {
  const values = [...current];
  for (const value of incoming) {
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

function resourceId(
  relation: "output" | "source",
  candidate: ResourceLocation,
  sourceItemId: string,
): string {
  return stableTimelineHash([
    "rah.conversation.resource.v1",
    relation,
    candidate.kind,
    candidate.path ?? candidate.url ?? `${candidate.label}\0${sourceItemId}`,
  ]);
}

function addOutput(
  outputs: Map<string, ConversationOutputProjection>,
  candidate: OutputCandidate,
  sourceItemId: string,
) {
  const id = resourceId("output", candidate, sourceItemId);
  const existing = outputs.get(id);
  if (!existing) {
    outputs.set(id, { ...candidate, id, sourceItemIds: [sourceItemId] });
    return;
  }
  const firstSeenAt = earliest(existing.firstSeenAt, candidate.firstSeenAt);
  const lastSeenAt = latest(existing.lastSeenAt, candidate.lastSeenAt);
  outputs.set(id, {
    ...existing,
    activity:
      !existing.lastSeenAt ||
      (candidate.lastSeenAt !== undefined && candidate.lastSeenAt >= existing.lastSeenAt)
        ? candidate.activity
        : existing.activity,
    confidence:
      existing.confidence === "authoritative" || candidate.confidence === "authoritative"
        ? "authoritative"
        : "inferred",
    sourceItemIds: appendUnique(existing.sourceItemIds, [sourceItemId]),
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
  });
}

function addSource(
  sources: Map<string, ConversationSourceProjection>,
  candidate: SourceCandidate,
  sourceItemId: string,
) {
  const id = resourceId("source", candidate, sourceItemId);
  const existing = sources.get(id);
  if (!existing) {
    sources.set(id, { ...candidate, id, sourceItemIds: [sourceItemId] });
    return;
  }
  const firstSeenAt = earliest(existing.firstSeenAt, candidate.firstSeenAt);
  const lastSeenAt = latest(existing.lastSeenAt, candidate.lastSeenAt);
  sources.set(id, {
    ...existing,
    activities: appendUnique(existing.activities, candidate.activities),
    confidence:
      existing.confidence === "authoritative" || candidate.confidence === "authoritative"
        ? "authoritative"
        : "inferred",
    sourceItemIds: appendUnique(existing.sourceItemIds, [sourceItemId]),
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
  });
}

function addOutputLocations(
  outputs: Map<string, ConversationOutputProjection>,
  locations: readonly ResourceLocation[],
  activity: ConversationOutputActivity,
  item: ConversationItemProjection,
) {
  for (const location of locations) {
    addOutput(
      outputs,
      { ...location, activity, confidence: "authoritative", ...itemTimes(item) },
      item.id,
    );
  }
}

function addSourceLocations(
  sources: Map<string, ConversationSourceProjection>,
  locations: readonly ResourceLocation[],
  activity: ConversationSourceActivity,
  item: ConversationItemProjection,
) {
  for (const location of locations) {
    addSource(
      sources,
      { ...location, activities: [activity], confidence: "authoritative", ...itemTimes(item) },
      item.id,
    );
  }
}

function sortResources<T extends ConversationOutputProjection | ConversationSourceProjection>(
  resources: Iterable<T>,
): T[] {
  return [...resources].sort((left, right) =>
    (left.firstSeenAt ?? "").localeCompare(right.firstSeenAt ?? "") ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id),
  );
}

export function projectConversationTurnResources(
  items: readonly ConversationItemProjection[],
): {
  outputs: ConversationOutputProjection[];
  sources: ConversationSourceProjection[];
} {
  const outputs = new Map<string, ConversationOutputProjection>();
  const sources = new Map<string, ConversationSourceProjection>();

  for (const item of items) {
    if (item.content.kind === "timeline") {
      const timeline = item.content.item;
      if (timeline.kind === "attachment") {
        const locations = [
          ...(timeline.path ? [pathLocation(timeline.path, timeline.mime)] : []),
          ...(timeline.url ? [urlLocation(timeline.url)] : []),
        ].filter((location): location is ResourceLocation => location !== undefined);
        addSourceLocations(sources, locations, "provided", item);
      } else if (timeline.kind === "user_message" && (timeline.imageCount ?? 0) > 0) {
        addSource(
          sources,
          {
            kind: "image",
            label: timeline.imageCount === 1 ? "Image" : `${timeline.imageCount} images`,
            activities: ["provided"],
            confidence: "authoritative",
            ...itemTimes(item),
          },
          item.id,
        );
      }
      continue;
    }
    if (item.status !== "completed") continue;

    if (item.content.kind === "observation") {
      const observation = item.content.observation;
      const locations = [
        ...subjectLocations(observation.subject),
        ...artifactLocations(observation.detail?.artifacts ?? []),
      ];
      const outputActivity = OUTPUT_OBSERVATION_ACTIVITY.get(observation.kind);
      const sourceActivity = SOURCE_OBSERVATION_ACTIVITY.get(observation.kind);
      if (outputActivity) addOutputLocations(outputs, locations, outputActivity, item);
      if (sourceActivity) addSourceLocations(sources, locations, sourceActivity, item);
      continue;
    }

    if (item.content.kind === "tool") {
      const tool = item.content.toolCall;
      const locations = artifactLocations(tool.detail?.artifacts ?? []);
      const outputActivity = OUTPUT_TOOL_ACTIVITY.get(tool.family);
      const sourceActivity = SOURCE_TOOL_ACTIVITY.get(tool.family);
      if (outputActivity) addOutputLocations(outputs, locations, outputActivity, item);
      if (sourceActivity) addSourceLocations(sources, locations, sourceActivity, item);
    }
  }

  return {
    outputs: sortResources(outputs.values()),
    sources: sortResources(sources.values()),
  };
}
