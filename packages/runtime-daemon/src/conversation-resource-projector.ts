import type {
  ConversationItemProjection,
  ConversationActivityDescriptor,
  ConversationActivityFileAction,
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
  ["web_search", "searched"],
  ["fetch", "fetched"],
  ["web_fetch", "fetched"],
  ["browser", "fetched"],
]);
const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
// Provider-native output resources are authoritative regardless of extension.
// This allowlist applies only to the compatibility fallback that infers an
// output from a successful write/edit plus an explicit final-answer link.
// Source-code edits belong in Changes unless the provider actually emits them
// as an attachment/artifact.
const FALLBACK_DELIVERABLE_EXTENSIONS = new Set([
  "7z",
  "arrow",
  "avif",
  "bz2",
  "csv",
  "db",
  "doc",
  "docx",
  "feather",
  "flac",
  "gif",
  "gz",
  "htm",
  "html",
  "ipynb",
  "jpeg",
  "jpg",
  "json",
  "jsonl",
  "m4a",
  "markdown",
  "md",
  "mdx",
  "mov",
  "mp3",
  "mp4",
  "odp",
  "ods",
  "odt",
  "parquet",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "pq",
  "rtf",
  "sqlite",
  "sqlite3",
  "svg",
  "tar",
  "tgz",
  "tsv",
  "txt",
  "wav",
  "webm",
  "webp",
  "xls",
  "xlsx",
  "xml",
  "xz",
  "zip",
]);
const WELL_KNOWN_EXTENSIONLESS_FILES = /^(?:dockerfile|gemfile|license|makefile|readme)(?:[-_.].*)?$/i;

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
  return !normalized ||
    normalized === "." ||
    normalized === "/dev/null" ||
    /^\d+(?:,\d+)?$/.test(normalized) ||
    /^\d*[<>]/.test(normalized)
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

function isReopenableSourcePath(value: string): boolean {
  if (/^(?:\/|[A-Za-z]:\/)/.test(value)) return true;
  if (/[\r\n\0()[\]{}='"`;|<>]/.test(value)) return false;
  const label = value.slice(value.lastIndexOf("/") + 1);
  return (
    value.includes("/") ||
    /^\.?[^/]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label) ||
    WELL_KNOWN_EXTENSIONLESS_FILES.test(label)
  );
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

function outputActivityForDescriptor(
  activity: ConversationActivityDescriptor,
  fileAction?: ConversationActivityFileAction,
): ConversationOutputActivity | undefined {
  if (fileAction === "created") return "written";
  if (fileAction === "edited") return "updated";
  if (fileAction === "deleted") return undefined;
  if (activity.action === "file_create") return "written";
  if (activity.action === "file_edit") return "updated";
  if (activity.action === "file_delete") return undefined;
  return activity.kind === "file_change" ? "updated" : undefined;
}

function sourceActivityForDescriptor(
  activity: ConversationActivityDescriptor,
  fileAction?: ConversationActivityFileAction,
): ConversationSourceActivity | undefined {
  if (fileAction === "read") return "read";
  if (activity.action === "file_read") return "read";
  if (activity.action === "web_search") return "searched";
  if (activity.action === "web_fetch" || activity.action === "browser") return "fetched";
  if (activity.kind === "file_read") return "read";
  if (activity.kind === "web") return "fetched";
  if (activity.kind === "git") return "fetched";
  return undefined;
}

function sourceLocationsForActivity(
  locations: readonly ResourceLocation[],
  activity: ConversationSourceActivity,
): ResourceLocation[] {
  return activity === "searched" || activity === "fetched"
    ? locations.filter((location) => Boolean(location.url))
    : [...locations];
}

function addActivityDescriptorResources(
  outputs: Map<string, ConversationOutputProjection>,
  sources: Map<string, ConversationSourceProjection>,
  activity: ConversationActivityDescriptor,
  item: ConversationItemProjection,
  surfacedOutputText: string,
) {
  for (const file of activity.files ?? []) {
    const location = pathLocation(file.path);
    if (!location) continue;
    const outputActivity = outputActivityForDescriptor(activity, file.action);
    if (outputActivity) {
      addOutputLocations(outputs, [location], outputActivity, item, surfacedOutputText);
    }
  }
  const urlLocations = (activity.urls ?? [])
    .map((url) => urlLocation(url))
    .filter((location): location is ResourceLocation => location !== undefined);
  const urlSourceActivity = sourceActivityForDescriptor(activity);
  if (urlSourceActivity) {
    addSourceLocations(sources, urlLocations, urlSourceActivity, item);
  }
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
  surfacedOutputText: string,
) {
  for (const location of locations) {
    if (
      activity !== "generated" &&
      (!isFallbackDeliverableLocation(location) ||
        !isExplicitlySurfacedOutput(location, surfacedOutputText))
    ) {
      continue;
    }
    addOutput(
      outputs,
      { ...location, activity, confidence: "authoritative", ...itemTimes(item) },
      item.id,
    );
  }
}

function isFallbackDeliverableLocation(location: ResourceLocation): boolean {
  if (location.kind === "image") return true;
  const locator = location.path ?? location.url ?? location.label;
  const clean = locator.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const separator = clean.lastIndexOf(".");
  if (separator < 0 || separator === clean.length - 1) return false;
  return FALLBACK_DELIVERABLE_EXTENSIONS.has(clean.slice(separator + 1));
}

function finalAnswerText(items: readonly ConversationItemProjection[]): string {
  return items
    .filter(
      (item) =>
        item.content.kind === "timeline" &&
        item.content.item.kind === "assistant_message" &&
        (item.role === "final" || item.content.item.phase === "final_answer"),
    )
    .map((item) =>
      item.content.kind === "timeline" && item.content.item.kind === "assistant_message"
        ? item.content.item.text
        : "",
    )
    .join("\n");
}

function isExplicitlySurfacedOutput(location: ResourceLocation, text: string): boolean {
  if (!text) return false;
  const locators = [location.path, location.url, location.label]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return locators.some((locator) => text.includes(locator));
}

function localMarkdownImageLocations(text: string): ResourceLocation[] {
  const locations: ResourceLocation[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const imageStart = text.indexOf("![", cursor);
    if (imageStart < 0) break;
    const destinationStart = text.indexOf("](", imageStart + 2);
    if (destinationStart < 0) break;

    let index = destinationStart + 2;
    while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;

    let destination = "";
    if (text[index] === "<") {
      const destinationEnd = text.indexOf(">", index + 1);
      if (destinationEnd < 0) {
        cursor = destinationStart + 2;
        continue;
      }
      destination = text.slice(index + 1, destinationEnd);
      cursor = destinationEnd + 1;
    } else {
      while (index < text.length) {
        const character = text[index] ?? "";
        if (character === "\\" && index + 1 < text.length) {
          destination += text[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (character === ")" || /\s/.test(character)) break;
        destination += character;
        index += 1;
      }
      cursor = Math.max(index + 1, destinationStart + 2);
    }

    if (!destination.startsWith("/")) continue;
    const location = pathLocation(destination);
    if (location?.kind === "image") locations.push(location);
  }

  return locations;
}

function standaloneLocalImageLinkLocations(text: string): ResourceLocation[] {
  const locations: ResourceLocation[] = [];
  let fence: { marker: string; length: number } | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(rawLine);
    if (fenceMatch) {
      const delimiter = fenceMatch[1]!;
      if (!fence) {
        fence = { marker: delimiter[0]!, length: delimiter.length };
      } else if (delimiter[0] === fence.marker && delimiter.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence || rawLine.includes("![")) continue;

    const match = /^(?:[^![\]]{0,120})?\[[^\]\r\n]+\]\(\s*(<[^>\r\n]+>|\/[^)\s\r\n]+)\s*\)\s*[.,;:。；：]?\s*$/.exec(
      rawLine.trim(),
    );
    const destination = match?.[1]?.replace(/^<|>$/g, "");
    if (!destination) continue;
    const location = pathLocation(destination);
    if (location?.kind === "image") locations.push(location);
  }

  return locations;
}

/**
 * Codex persists files supplied through Desktop in a small, human-readable
 * preamble.  The same preamble is present in stored rollout history even when
 * the binary image payload is represented separately as base64.  Treat only
 * entries inside that explicit preamble as user-provided sources; ordinary
 * paths mentioned in the prompt must not become Sources.
 */
function codexMentionedFileLocations(text: string): ResourceLocation[] {
  const startMarker = "# Files mentioned by the user:";
  const endMarker = "## My request for Codex:";
  const start = text.indexOf(startMarker);
  if (start < 0) return [];
  const contentStart = start + startMarker.length;
  const end = text.indexOf(endMarker, contentStart);
  const preamble = text.slice(contentStart, end < 0 ? text.length : end);
  const locations = new Map<string, ResourceLocation>();

  for (const line of preamble.split(/\r?\n/)) {
    const match = /^##\s+(.+?):\s+((?:\/|[A-Za-z]:[\\/]).+?)\s*$/.exec(line);
    if (!match) continue;
    const suppliedLabel = match[1]?.trim();
    const location = pathLocation(match[2] ?? "");
    if (!location) continue;
    locations.set(location.path ?? location.label, {
      ...location,
      ...(suppliedLabel ? { label: suppliedLabel } : {}),
    });
  }
  return [...locations.values()];
}

function addSourceLocations(
  sources: Map<string, ConversationSourceProjection>,
  locations: readonly ResourceLocation[],
  activity: ConversationSourceActivity,
  item: ConversationItemProjection,
) {
  for (const location of locations) {
    // Sources are reopenable provenance, not a dump of shell argv. Local
    // project files read by the agent belong to Files/process activity, not
    // Sources; only explicit user attachments may contribute local paths.
    // Keep this guard for older/provider-native projections as well.
    if (
      activity !== "provided" &&
      location.path &&
      !isReopenableSourcePath(location.path)
    ) {
      continue;
    }
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

export function projectConversationTurnResources(items: readonly ConversationItemProjection[]): {
  outputs: ConversationOutputProjection[];
  sources: ConversationSourceProjection[];
} {
  const outputs = new Map<string, ConversationOutputProjection>();
  const sources = new Map<string, ConversationSourceProjection>();
  const surfacedOutputText = finalAnswerText(items);

  for (const item of items) {
    if (item.content.kind === "timeline") {
      const timeline = item.content.item;
      if (timeline.kind === "attachment") {
        const locations = [
          ...(timeline.path ? [pathLocation(timeline.path, timeline.mime)] : []),
          ...(timeline.url ? [urlLocation(timeline.url)] : []),
        ].filter((location): location is ResourceLocation => location !== undefined);
        if (item.role === "process" || item.role === "final") {
          for (const location of locations) {
            addOutput(
              outputs,
              {
                ...location,
                activity: "generated",
                confidence: "authoritative",
                ...itemTimes(item),
              },
              item.id,
            );
          }
        } else {
          addSourceLocations(sources, locations, "provided", item);
        }
      } else if (timeline.kind === "user_message") {
        const mentionedFiles = codexMentionedFileLocations(timeline.text);
        addSourceLocations(sources, mentionedFiles, "provided", item);

        for (const attachment of timeline.attachments ?? []) {
          addSource(
            sources,
            {
              kind: attachment.kind === "image" ? "image" : "file",
              label: attachment.name,
              mimeType: attachment.mediaType,
              activities: ["provided"],
              confidence: "authoritative",
              ...itemTimes(item),
            },
            `${item.id}:${attachment.id}`,
          );
        }

        const locatedImageCount = mentionedFiles.filter(
          (location) => location.kind === "image",
        ).length;
        const structuredImageCount = (timeline.attachments ?? []).filter(
          (attachment) => attachment.kind === "image",
        ).length;
        const unresolvedImageCount = Math.max(
          0,
          (timeline.imageCount ?? 0) - locatedImageCount - structuredImageCount,
        );
        if (unresolvedImageCount > 0) {
          addSource(
            sources,
            {
              kind: "image",
              label: unresolvedImageCount === 1 ? "Image" : `${unresolvedImageCount} images`,
              activities: ["provided"],
              confidence: "authoritative",
              ...itemTimes(item),
            },
            `${item.id}:unresolved-images`,
          );
        }
      } else if (
        timeline.kind === "assistant_message" &&
        (item.role === "final" || timeline.phase === "final_answer")
      ) {
        for (const location of standaloneLocalImageLinkLocations(timeline.text)) {
          addOutput(
            outputs,
            {
              ...location,
              activity: "generated",
              confidence: "inferred",
              ...itemTimes(item),
            },
            item.id,
          );
        }
        for (const location of localMarkdownImageLocations(timeline.text)) {
          addOutput(
            outputs,
            {
              ...location,
              activity: "generated",
              confidence: "authoritative",
              ...itemTimes(item),
            },
            item.id,
          );
        }
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
      if (outputActivity) {
        addOutputLocations(
          outputs,
          locations,
          outputActivity,
          item,
          surfacedOutputText,
        );
      }
      if (sourceActivity) {
        addSourceLocations(
          sources,
          sourceLocationsForActivity(locations, sourceActivity),
          sourceActivity,
          item,
        );
      }
      if (observation.activity) {
        addActivityDescriptorResources(
          outputs,
          sources,
          observation.activity,
          item,
          surfacedOutputText,
        );
      }
      continue;
    }

    if (item.content.kind === "tool") {
      const tool = item.content.toolCall;
      const locations = artifactLocations(tool.detail?.artifacts ?? []);
      const outputActivity = OUTPUT_TOOL_ACTIVITY.get(tool.family);
      const sourceActivity = SOURCE_TOOL_ACTIVITY.get(tool.family);
      if (outputActivity) {
        addOutputLocations(
          outputs,
          locations,
          outputActivity,
          item,
          surfacedOutputText,
        );
      }
      if (sourceActivity) {
        addSourceLocations(
          sources,
          sourceLocationsForActivity(locations, sourceActivity),
          sourceActivity,
          item,
        );
      }
      if (tool.activity) {
        addActivityDescriptorResources(
          outputs,
          sources,
          tool.activity,
          item,
          surfacedOutputText,
        );
      }
    }
  }

  return {
    outputs: sortResources(outputs.values()),
    sources: sortResources(sources.values()),
  };
}
