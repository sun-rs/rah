import type {
  ConversationActivitySummary,
  ConversationItemProjection,
} from "./conversation";
import type {
  ConversationActivityAction,
  ConversationActivityDescriptor,
  ConversationActivityFileAction,
  ConversationActivityFileTarget,
  ConversationActivityKind,
  MessagePartKind,
  ObservationKind,
  TimelineItem,
  ToolCall,
  ToolCallArtifact,
  ToolFamily,
  WorkbenchObservation,
} from "./events";

const ACTIVITY_ORDER: readonly ConversationActivityKind[] = [
  "thinking",
  "command",
  "file_read",
  "file_change",
  "search",
  "web",
  "git",
  "subagent",
  "permission",
  "plan",
  "automation",
  "tool",
];

export function conversationActivityKindForToolFamily(
  family: ToolFamily,
): ConversationActivityKind {
  switch (family) {
    case "shell":
    case "test":
    case "build":
    case "lint":
      return "command";
    case "file_read":
      return "file_read";
    case "file_write":
    case "file_edit":
    case "patch":
    case "notebook":
    case "media":
    case "preview":
      return "file_change";
    case "search":
      return "search";
    case "fetch":
    case "web_search":
    case "web_fetch":
    case "browser":
      return "web";
    case "git":
    case "worktree":
      return "git";
    case "subagent":
      return "subagent";
    case "plan":
    case "todo":
      return "plan";
    case "automation":
      return "automation";
    default:
      return "tool";
  }
}

export function conversationActivityKindForObservation(
  kind: ObservationKind,
): ConversationActivityKind {
  switch (kind) {
    case "command.run":
    case "test.run":
    case "build.run":
    case "lint.run":
      return "command";
    case "file.read":
    case "file.list":
    case "media.read":
      return "file_read";
    case "file.write":
    case "file.edit":
    case "patch.apply":
      return "file_change";
    case "file.search":
    case "workspace.scan":
      return "search";
    case "web.search":
    case "web.fetch":
      return "web";
    case "git.status":
    case "git.diff":
    case "git.apply":
    case "worktree.setup":
      return "git";
    case "subagent.lifecycle":
      return "subagent";
    case "permission.change":
    case "question.side":
      return "permission";
    case "plan.update":
    case "todo.update":
      return "plan";
    case "automation.run":
      return "automation";
    default:
      return "tool";
  }
}

export function conversationActivityKindForTimeline(
  item: TimelineItem,
): ConversationActivityKind | null {
  switch (item.kind) {
    case "assistant_message":
    case "reasoning":
    case "compaction":
      return "thinking";
    case "plan":
    case "step":
    case "todo":
      return "plan";
    case "side_question":
      return "permission";
    default:
      return null;
  }
}

export function conversationActivityKindForMessagePart(
  kind: MessagePartKind,
): ConversationActivityKind {
  switch (kind) {
    case "reasoning":
    case "compaction":
      return "thinking";
    case "agent":
    case "subtask":
      return "subagent";
    case "patch":
    case "file":
    case "media":
      return "file_change";
    case "step":
      return "plan";
    default:
      return "tool";
  }
}

export function conversationActivityKindForItem(
  item: ConversationItemProjection,
): ConversationActivityKind | null {
  if (item.role !== "process") return null;
  switch (item.content.kind) {
    case "timeline":
      return conversationActivityKindForTimeline(item.content.item);
    case "tool":
      return item.content.toolCall.activity?.kind ??
        conversationActivityKindForToolFamily(item.content.toolCall.family);
    case "observation":
      return item.content.observation.activity?.kind ??
        conversationActivityKindForObservation(item.content.observation.kind);
    case "permission":
      return "permission";
    case "operation":
      return item.content.operation.kind === "automation" ? "automation" : "tool";
    case "message_part":
      return conversationActivityKindForMessagePart(item.content.part.kind);
  }
}

export type ConversationActivityBatchKind =
  | "file_change"
  | "file_read_command"
  | "file_read"
  | "command"
  | "web"
  | "git"
  | "subagent"
  | "plan"
  | "automation"
  | "tool";

/** Semantic aggregate for one uninterrupted run of provider activity. */
export interface ConversationActivityBatchSummary {
  kind: ConversationActivityBatchKind;
  primaryKind: ConversationActivityKind;
  totalCount: number;
  commandCount: number;
  readCount: number;
  changeCount: number;
  webCount: number;
  fileCount: number;
}

function firstString(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedHttpUrl(value: string): string | undefined {
  const candidate = value.trim().replace(/[\])},.;:]+$/g, "");
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function httpUrlsFromText(value: string): string[] {
  return uniqueStrings(
    Array.from(value.matchAll(/https?:\/\/[^\s<>"'`]+/g), (match) => match[0]!)
      .map(normalizedHttpUrl)
      .filter((url): url is string => Boolean(url)),
  );
}

function httpUrlsFromUnknown(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === "string") return httpUrlsFromText(value);
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((item) => httpUrlsFromUnknown(item, depth + 1)));
  }
  if (typeof value !== "object") return [];
  return uniqueStrings(
    Object.values(value as Record<string, unknown>).flatMap((item) =>
      httpUrlsFromUnknown(item, depth + 1)
    ),
  );
}

function artifactUrls(artifacts: readonly ToolCallArtifact[]): string[] {
  const explicit = uniqueStrings(
    artifacts.flatMap((artifact) => {
      if (artifact.kind === "urls") {
        return artifact.urls.flatMap((url) => httpUrlsFromText(url));
      }
      if (artifact.kind === "image" && artifact.url) {
        return httpUrlsFromText(artifact.url);
      }
      return [];
    }),
  );
  if (explicit.length > 0) return explicit;
  return uniqueStrings(
    artifacts.flatMap((artifact) => {
      switch (artifact.kind) {
        case "text":
        case "diff":
          return httpUrlsFromText(artifact.text);
        case "json":
          return httpUrlsFromUnknown(artifact.value);
        case "table":
          return httpUrlsFromUnknown(artifact.rows);
        default:
          return [];
      }
    }),
  );
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function scriptString(input: Record<string, unknown> | undefined): string | undefined {
  return firstString(input, ["value", "code", "script"]);
}

function nestedToolNames(script: string): string[] {
  return Array.from(
    script.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g),
    (match) => match[1]!,
  );
}

function unquoteJsString(value: string, quote: string): string {
  if (quote === '"') {
    try {
      return JSON.parse(`${quote}${value}${quote}`) as string;
    } catch {
      // Keep a useful value even when a provider wrapper is not strict JSON.
    }
  }
  return value
    .replace(new RegExp(`\\\\${quote}`, "g"), quote)
    .replace(/\\\\n/g, "\n")
    .replace(/\\\\t/g, "\t")
    .replace(/\\\\\\\\/g, "\\");
}

function jsObjectStringFields(script: string, field: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`\\b${field}\\s*:`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script)) !== null) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(script[cursor] ?? "")) cursor += 1;
    const quote = script[cursor];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    cursor += 1;
    let escaped = false;
    let value = "";
    for (; cursor < script.length; cursor += 1) {
      const character = script[cursor];
      if (character === undefined) break;
      if (!escaped && character === quote) {
        values.push(unquoteJsString(value, quote));
        pattern.lastIndex = cursor + 1;
        break;
      }
      value += character;
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
    }
  }
  return values;
}

function jsObjectStringField(script: string, field: string): string | undefined {
  return jsObjectStringFields(script, field)[0];
}

function commandArtifact(
  artifacts: readonly ToolCallArtifact[],
): Extract<ToolCallArtifact, { kind: "command" }> | undefined {
  return artifacts.find(
    (artifact): artifact is Extract<ToolCallArtifact, { kind: "command" }> =>
      artifact.kind === "command",
  );
}

function stringsFromInput(
  input: Record<string, unknown> | undefined,
  scalarKeys: readonly string[],
  arrayKeys: readonly string[],
): string[] {
  const values: string[] = [];
  for (const key of scalarKeys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  for (const key of arrayKeys) {
    const value = input?.[key];
    if (!Array.isArray(value)) continue;
    values.push(...value.filter((item): item is string => typeof item === "string"));
  }
  return uniqueStrings(values);
}

function fileTargetsFromPatch(patch: string): ConversationActivityFileTarget[] {
  const targets: ConversationActivityFileTarget[] = [];
  for (const line of patch.replace(/\\n/g, "\n").split(/\r?\n/)) {
    const match = /^\*\*\* (Update|Add|Delete) File:\s+(.+)$/.exec(line);
    if (match?.[2]) {
      const action: ConversationActivityFileAction =
        match[1] === "Add" ? "created" : match[1] === "Delete" ? "deleted" : "edited";
      targets.push({ path: match[2].trim(), action });
      continue;
    }
    const move = /^\*\*\* Move to:\s+(.+)$/.exec(line);
    if (move?.[1]) targets.push({ path: move[1].trim(), action: "edited" });
  }
  return targets;
}

function dedupeFileTargets(
  targets: readonly ConversationActivityFileTarget[],
): ConversationActivityFileTarget[] {
  const result = new Map<string, ConversationActivityFileTarget>();
  for (const target of targets) {
    const path = target.path.trim();
    if (!path) continue;
    const current = result.get(path);
    result.set(path, current?.action ? current : { path, ...(target.action ? { action: target.action } : {}) });
  }
  return [...result.values()];
}

function artifactFileTargets(
  artifacts: readonly ToolCallArtifact[],
  action?: ConversationActivityFileAction,
): ConversationActivityFileTarget[] {
  return artifacts.flatMap((artifact) => {
    if (artifact.kind === "file_refs") {
      return artifact.files.map((path) => ({ path, ...(action ? { action } : {}) }));
    }
    if (artifact.kind === "diff" || (artifact.kind === "text" && artifact.label.toLowerCase().includes("patch"))) {
      return fileTargetsFromPatch(artifact.text);
    }
    if (artifact.kind === "image" && artifact.path) {
      return [{ path: artifact.path, ...(action ? { action } : {}) }];
    }
    return [];
  });
}

function inferFileChangeAction(
  label: string | undefined,
  targets: readonly ConversationActivityFileTarget[],
): Extract<ConversationActivityAction, "file_create" | "file_edit" | "file_delete"> {
  const actions = new Set(targets.map((target) => target.action).filter(Boolean));
  if (actions.size === 1 && actions.has("created")) return "file_create";
  if (actions.size === 1 && actions.has("deleted")) return "file_delete";
  if (/\b(?:creat|add)(?:e|ed|ing)?\b/i.test(label ?? "")) return "file_create";
  if (/\bdelet(?:e|ed|ing)?\b/i.test(label ?? "")) return "file_delete";
  return "file_edit";
}

function fileTargetsForTool(
  toolCall: ToolCall,
  action?: ConversationActivityFileAction,
): ConversationActivityFileTarget[] {
  const artifacts = toolCall.detail?.artifacts ?? [];
  const inputPaths = stringsFromInput(
    toolCall.input,
    ["path", "file", "file_path", "filePath", "filename", "directory", "root"],
    ["paths", "files", "file_paths", "filePaths"],
  );
  const patch = firstString(toolCall.input, ["patch", "diff"]);
  return dedupeFileTargets([
    ...(patch ? fileTargetsFromPatch(patch) : []),
    ...inputPaths.map((path) => ({ path, ...(action ? { action } : {}) })),
    ...artifactFileTargets(artifacts, action),
  ]);
}

function stripShellQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function shellWords(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(stripShellQuotes);
}

function dynamicShellPath(value: string): boolean {
  return value.startsWith("$") || value.includes("*") || value === "{" || value === "}";
}

function looksLikeSedScript(value: string): boolean {
  return (
    /^\d*(?:,\d*)?[a-zA-Z]$/.test(value) ||
    /^\/.+\/[a-zA-Z]*$/.test(value) ||
    /^s(.).*\1.*\1[a-zA-Z]*$/.test(value)
  );
}

function commandReadFiles(command: string): string[] {
  const refs: string[] = [];
  for (const match of command.matchAll(/(?:^|[\s;&|{])sed\s+(?<args>[^\r\n;&|}]+)/g)) {
    const words = shellWords(match.groups?.args ?? "");
    let sawScript = false;
    let skipScript = false;
    for (const word of words) {
      if (word === "-e" || word === "--expression" || word === "-f" || word === "--file") {
        skipScript = true;
        continue;
      }
      if (word.startsWith("-e") && word.length > 2) {
        sawScript = true;
        continue;
      }
      if (word.startsWith("-")) continue;
      if (skipScript) {
        skipScript = false;
        sawScript = true;
        continue;
      }
      if (!sawScript && looksLikeSedScript(word)) {
        sawScript = true;
        continue;
      }
      if (!dynamicShellPath(word)) refs.push(word);
    }
  }
  const direct = [...command.matchAll(/(?:^|\s)(?:cat|less|head|tail|nl)\s+(?:-[^\s]+\s+)*(?<path>[^\s|;&]+)/g)]
    .map((match) => match.groups?.path)
    .filter((value): value is string => Boolean(value))
    .map(stripShellQuotes)
    .filter((value) => !value.startsWith("-") && !dynamicShellPath(value));
  return uniqueStrings([...refs, ...direct]);
}

function commandListTarget(command: string): string | undefined {
  if (!/^\s*(?:ls|tree)\b/.test(command)) return undefined;
  return shellWords(command)
    .slice(1)
    .find((word) => !word.startsWith("-") && !dynamicShellPath(word));
}

function commandSearchEvidence(command: string): { query?: string; file?: string } | undefined {
  if (!/^\s*(?:rg|grep|fd|find)\b/.test(command)) return undefined;
  const words = shellWords(command).slice(1).filter((word) => !word.startsWith("-"));
  const query = words[0];
  const file = words[1] && !dynamicShellPath(words[1]) ? words[1] : undefined;
  return {
    ...(query ? { query } : {}),
    ...(file ? { file } : {}),
  };
}

function semanticCommandActivity(args: {
  command: string;
  cwd?: string;
  label: string;
  operationCount?: number;
}): ConversationActivityDescriptor {
  const command = normalizeInlineText(args.command);
  const patchFiles = fileTargetsFromPatch(args.command);
  if (patchFiles.length > 0) {
    return {
      kind: "file_change",
      action: inferFileChangeAction(args.label, patchFiles),
      ...(args.operationCount ? { operationCount: args.operationCount } : {}),
      files: patchFiles,
      label: args.label,
    };
  }
  const readFiles = commandReadFiles(args.command);
  if (readFiles.length > 0) {
    return {
      kind: "file_read",
      action: "command",
      ...(args.operationCount ? { operationCount: args.operationCount } : {}),
      ...(args.operationCount === undefined || args.operationCount === 1 ? { command } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      files: readFiles.map((path) => ({ path, action: "read" })),
      label: args.label,
    };
  }
  const listTarget = commandListTarget(args.command);
  if (listTarget !== undefined || /^\s*(?:ls|tree)\b/.test(args.command)) {
    return {
      kind: "file_read",
      action: "file_list",
      ...(listTarget ? { files: [{ path: listTarget, action: "listed" }] } : {}),
      label: args.label,
    };
  }
  const search = commandSearchEvidence(args.command);
  if (search) {
    return {
      kind: "search",
      action: "file_search",
      ...(search.file ? { files: [{ path: search.file, action: "searched" }] } : {}),
      ...(search.query ? { query: search.query } : {}),
      label: args.label,
    };
  }
  return {
    kind: "command",
    action: "command",
    ...(args.operationCount ? { operationCount: args.operationCount } : {}),
    ...(args.operationCount === undefined || args.operationCount === 1 ? { command } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    label: args.label,
  };
}

function wrapperActivity(toolCall: ToolCall): ConversationActivityDescriptor | undefined {
  const script = scriptString(toolCall.input);
  if (!script) return undefined;
  const names = nestedToolNames(script);
  if (names.length === 0) return undefined;
  const operationCount = names.length;
  const uniqueNames = new Set(names);
  const label = toolCall.summary ?? toolCall.title ?? toolCall.providerToolName;
  if ([...uniqueNames].every((name) => name === "exec_command")) {
    const commands = jsObjectStringFields(script, "cmd");
    const cwd = jsObjectStringField(script, "workdir");
    if (commands.length === 1) {
      return semanticCommandActivity({ command: commands[0]!, ...(cwd ? { cwd } : {}), label });
    }
    const semanticCommands = commands.map((command) =>
      semanticCommandActivity({ command, ...(cwd ? { cwd } : {}), label }),
    );
    const files = dedupeFileTargets(semanticCommands.flatMap((activity) => activity.files ?? []));
    const hasChange = semanticCommands.some((activity) => activity.kind === "file_change");
    const hasRead = semanticCommands.some(
      (activity) => activity.kind === "file_read" || activity.kind === "search",
    );
    return {
      kind: hasChange ? "file_change" : hasRead ? "file_read" : "command",
      action: hasChange ? "file_edit" : "command",
      operationCount,
      ...(cwd ? { cwd } : {}),
      ...(files.length ? { files } : {}),
      label,
    };
  }
  if ([...uniqueNames].every((name) => name === "apply_patch")) {
    const files = fileTargetsFromPatch(script);
    return {
      kind: "file_change",
      action: inferFileChangeAction(label, files),
      operationCount,
      ...(files.length ? { files } : {}),
      label,
    };
  }
  if (uniqueNames.size > 1) {
    return { kind: "tool", action: "tool", operationCount, label };
  }
  switch (names[0]) {
    case "update_plan":
      return { kind: "plan", action: "plan", operationCount, label };
    case "web__run": {
      const queries = jsObjectStringFields(script, "q");
      const refIds = jsObjectStringFields(script, "ref_id");
      const directUrls = [
        ...jsObjectStringFields(script, "url"),
        ...refIds,
      ].flatMap((value) => httpUrlsFromText(value));
      const urls = uniqueStrings([
        ...directUrls,
        ...artifactUrls(toolCall.detail?.artifacts ?? []),
      ]);
      const hasSearch = /\b(?:search_query|image_query)\s*:/.test(script);
      const hasFetch = /\b(?:open|click|find|screenshot)\s*:/.test(script);
      const webOperationCount = Math.max(
        operationCount,
        queries.length,
        hasFetch ? refIds.length : 0,
      );
      return {
        kind: "web",
        action: hasSearch || !hasFetch ? "web_search" : "web_fetch",
        operationCount: webOperationCount,
        ...(urls.length ? { urls } : {}),
        ...(queries.length ? { query: uniqueStrings(queries).join(", ") } : {}),
        label,
      };
    }
    case "mcp__node_repl__js":
      return { kind: "web", action: "browser", operationCount, label };
    case "view_image": {
      const path = jsObjectStringField(script, "path");
      return {
        kind: "file_read",
        action: "file_read",
        operationCount,
        ...(path ? { files: [{ path, action: "read" }] } : {}),
        label,
      };
    }
    case "write_stdin":
    case "wait":
      return { kind: "command", action: "tool", operationCount, label: "Wait for command" };
    default:
      return { kind: "tool", action: "tool", operationCount, label };
  }
}

export function deriveConversationActivityForToolCall(
  toolCall: ToolCall,
): ConversationActivityDescriptor {
  const wrapper = wrapperActivity(toolCall);
  if (wrapper) return wrapper;
  const kind = conversationActivityKindForToolFamily(toolCall.family);
  const label = toolCall.summary ?? toolCall.title ?? toolCall.providerToolName;
  const artifacts = toolCall.detail?.artifacts ?? [];
  const artifactCommand = commandArtifact(artifacts);
  const command = artifactCommand?.command ??
    firstString(toolCall.input, ["command", "cmd"]);
  const cwd = artifactCommand?.cwd ?? firstString(toolCall.input, ["cwd", "workdir"]);
  const query = firstString(toolCall.input, ["query", "pattern", "search"]);
  const urls = uniqueStrings([
    ...stringsFromInput(toolCall.input, ["url", "uri"], ["urls", "uris"]),
    ...artifactUrls(artifacts),
  ]);

  let action: ConversationActivityAction;
  let fileAction: ConversationActivityFileAction | undefined;
  switch (toolCall.family) {
    case "shell":
    case "test":
    case "build":
    case "lint":
      action = "command";
      break;
    case "file_read":
      action = "file_read";
      fileAction = "read";
      break;
    case "file_write":
    case "file_edit":
    case "patch": {
      const preliminary = fileTargetsForTool(toolCall);
      action = inferFileChangeAction(label, preliminary);
      fileAction = action === "file_create" ? "created" : action === "file_delete" ? "deleted" : "edited";
      break;
    }
    case "search":
      action = "file_search";
      fileAction = "searched";
      break;
    case "fetch":
    case "web_fetch":
      action = "web_fetch";
      break;
    case "web_search":
      action = "web_search";
      break;
    case "browser":
      action = "browser";
      break;
    case "git":
    case "worktree":
      action = "git";
      break;
    case "subagent":
      action = "subagent";
      break;
    case "plan":
    case "todo":
      action = "plan";
      break;
    case "automation":
      action = "automation";
      break;
    default:
      action = "tool";
  }
  const files = fileTargetsForTool(toolCall, fileAction);
  if (toolCall.family === "shell" && command) {
    return semanticCommandActivity({ command, ...(cwd ? { cwd } : {}), label });
  }
  return {
    kind,
    action,
    ...(command ? { command: normalizeInlineText(command) } : {}),
    ...(cwd ? { cwd } : {}),
    ...(files.length ? { files } : {}),
    ...(urls.length ? { urls } : {}),
    ...(query ? { query } : {}),
    label,
  };
}

function observationFileAction(kind: ObservationKind): ConversationActivityFileAction | undefined {
  switch (kind) {
    case "file.read":
    case "media.read":
      return "read";
    case "file.list":
      return "listed";
    case "file.search":
    case "workspace.scan":
      return "searched";
    case "file.write":
    case "file.edit":
    case "patch.apply":
    case "git.apply":
      return "edited";
    default:
      return undefined;
  }
}

export function deriveConversationActivityForObservation(
  observation: WorkbenchObservation,
): ConversationActivityDescriptor {
  const kind = conversationActivityKindForObservation(observation.kind);
  const subject = observation.subject;
  const artifacts = observation.detail?.artifacts ?? [];
  const patchTargets = artifactFileTargets(artifacts);
  const defaultFileAction = observationFileAction(observation.kind);
  const files = dedupeFileTargets([
    ...(subject?.files ?? []).map((path) => ({
      path,
      ...(defaultFileAction ? { action: defaultFileAction } : {}),
    })),
    ...patchTargets,
  ]);
  let action: ConversationActivityAction;
  switch (observation.kind) {
    case "file.read":
      action = subject?.command ? "command" : "file_read";
      break;
    case "media.read":
      action = "file_read";
      break;
    case "file.list":
      action = "file_list";
      break;
    case "file.search":
    case "workspace.scan":
      action = "file_search";
      break;
    case "file.write":
    case "file.edit":
    case "patch.apply":
      action = inferFileChangeAction(observation.title, files);
      break;
    case "command.run":
    case "test.run":
    case "build.run":
    case "lint.run":
      action = "command";
      break;
    case "git.status":
    case "git.diff":
    case "git.apply":
    case "worktree.setup":
      action = "git";
      break;
    case "web.search":
      action = "web_search";
      break;
    case "web.fetch":
      action = "web_fetch";
      break;
    case "subagent.lifecycle":
      action = "subagent";
      break;
    case "plan.update":
    case "todo.update":
      action = "plan";
      break;
    case "permission.change":
    case "question.side":
      action = "permission";
      break;
    case "automation.run":
      action = "automation";
      break;
    default:
      action = "tool";
  }
  return {
    kind,
    action,
    ...(subject?.command ? { command: normalizeInlineText(subject.command) } : {}),
    ...(subject?.cwd ? { cwd: subject.cwd } : {}),
    ...(files.length ? { files } : {}),
    ...(subject?.urls?.length ? { urls: uniqueStrings(subject.urls) } : {}),
    ...(subject?.query ? { query: subject.query } : {}),
    label: observation.summary ?? observation.title,
  };
}

export function normalizeToolCallConversationActivity(toolCall: ToolCall): ToolCall {
  return toolCall.activity
    ? toolCall
    : { ...toolCall, activity: deriveConversationActivityForToolCall(toolCall) };
}

export function normalizeObservationConversationActivity(
  observation: WorkbenchObservation,
): WorkbenchObservation {
  return observation.activity
    ? observation
    : { ...observation, activity: deriveConversationActivityForObservation(observation) };
}

function isReadActivity(activity: ConversationActivityDescriptor): boolean {
  return (
    activity.kind === "file_read" ||
    activity.kind === "search" ||
    activity.action === "file_read" ||
    activity.action === "file_list" ||
    activity.action === "file_search"
  );
}

function isChangeActivity(activity: ConversationActivityDescriptor): boolean {
  return (
    activity.kind === "file_change" ||
    activity.action === "file_create" ||
    activity.action === "file_edit" ||
    activity.action === "file_delete"
  );
}

export function summarizeConversationActivityBatch(
  activities: readonly ConversationActivityDescriptor[],
): ConversationActivityBatchSummary {
  const commandCount = activities.reduce(
    (count, activity) => count + (activity.action === "command" ? activity.operationCount ?? 1 : 0),
    0,
  );
  const readCount = activities.filter(isReadActivity).length;
  const changeCount = activities.filter(isChangeActivity).length;
  const webCount = activities.filter((activity) => activity.kind === "web").length;
  const fileCount = new Set(
    activities.flatMap((activity) => activity.files?.map((file) => file.path) ?? []),
  ).size;
  let kind: ConversationActivityBatchKind;
  let primaryKind: ConversationActivityKind;
  if (changeCount > 0) {
    kind = "file_change";
    primaryKind = "file_change";
  } else if (readCount > 0 && commandCount > 0) {
    kind = "file_read_command";
    primaryKind = "file_read";
  } else if (readCount > 0) {
    kind = "file_read";
    primaryKind = "file_read";
  } else if (commandCount > 0) {
    kind = "command";
    primaryKind = "command";
  } else if (webCount > 0) {
    kind = "web";
    primaryKind = "web";
  } else if (activities.some((activity) => activity.kind === "git")) {
    kind = "git";
    primaryKind = "git";
  } else if (activities.some((activity) => activity.kind === "subagent")) {
    kind = "subagent";
    primaryKind = "subagent";
  } else if (activities.some((activity) => activity.kind === "plan")) {
    kind = "plan";
    primaryKind = "plan";
  } else if (activities.some((activity) => activity.kind === "automation")) {
    kind = "automation";
    primaryKind = "automation";
  } else {
    kind = "tool";
    primaryKind = activities[0]?.kind ?? "tool";
  }
  return {
    kind,
    primaryKind,
    totalCount: activities.length,
    commandCount,
    readCount,
    changeCount,
    webCount,
    fileCount,
  };
}

function numericExitCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function conversationActivityFailureDisposition(
  item: ConversationItemProjection,
): "none" | "issue" | "failure" {
  if (item.status !== "failed") return "none";
  if (
    item.content.kind === "observation" &&
    item.content.observation.exitCode !== undefined
  ) {
    return "issue";
  }
  if (
    item.content.kind === "tool" &&
    numericExitCode(item.content.toolCall.result?.exitCode) !== undefined
  ) {
    return "issue";
  }
  return "failure";
}

export function summarizeConversationActivities(
  items: readonly ConversationItemProjection[],
): ConversationActivitySummary[] {
  const summaries = new Map<ConversationActivityKind, ConversationActivitySummary>();
  for (const item of items) {
    const kind = conversationActivityKindForItem(item);
    if (!kind) continue;
    const summary = summaries.get(kind) ?? {
      kind,
      totalCount: 0,
      runningCount: 0,
      interruptedCount: 0,
      failureCount: 0,
      issueCount: 0,
    };
    summary.totalCount += 1;
    if (item.status === "pending" || item.status === "running") {
      summary.runningCount += 1;
    } else if (item.status === "interrupted") {
      summary.interruptedCount += 1;
    }
    const failure = conversationActivityFailureDisposition(item);
    if (failure === "issue") summary.issueCount += 1;
    if (failure === "failure") summary.failureCount += 1;
    summaries.set(kind, summary);
  }
  return ACTIVITY_ORDER.flatMap((kind) => {
    const summary = summaries.get(kind);
    return summary ? [summary] : [];
  });
}
