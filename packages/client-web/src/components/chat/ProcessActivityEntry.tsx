import type {
  ConversationActivityDescriptor,
  ToolCallArtifact,
} from "@rah/runtime-protocol";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { FeedEntry } from "../../types";
import { entryActivityDescriptor } from "./assistant-process-groups";
import { ConversationActivityActionIcon } from "./conversation-activity-display";
import { DiffBlock } from "./DiffBlock";

function statusForEntry(entry: FeedEntry) {
  if (entry.kind === "tool_call" || entry.kind === "observation") return entry.status;
  if (entry.kind === "message_part") {
    return entry.status === "streaming"
      ? "running"
      : entry.status === "removed"
        ? "interrupted"
        : "completed";
  }
  return "completed";
}

function rawWrapperInputArtifact(
  artifact: ToolCallArtifact,
  descriptor: ConversationActivityDescriptor,
) {
  if (artifact.kind !== "json" || (artifact.label !== "input" && artifact.label !== "raw")) {
    return false;
  }
  if (!artifact.value || typeof artifact.value !== "object" || Array.isArray(artifact.value)) {
    return false;
  }
  const value = (artifact.value as Record<string, unknown>).value;
  return typeof value === "string" && value.includes("tools.") && Boolean(descriptor.command);
}

function entryArtifacts(entry: FeedEntry): ToolCallArtifact[] {
  const descriptor = entryActivityDescriptor(entry);
  if (entry.kind === "tool_call") {
    const detailArtifacts = (entry.toolCall.detail?.artifacts ?? []).filter(
      (artifact) => !descriptor || !rawWrapperInputArtifact(artifact, descriptor),
    );
    const hasCommand = detailArtifacts.some((artifact) => artifact.kind === "command");
    if (descriptor?.command && !hasCommand) {
      return [
        {
          kind: "command",
          command: descriptor.command,
          ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
        },
        ...detailArtifacts,
      ];
    }
    if (detailArtifacts.length) return detailArtifacts;
    if (entry.toolCall.result && Object.keys(entry.toolCall.result).length) {
      return [{ kind: "json", label: "result", value: entry.toolCall.result }];
    }
    if (entry.toolCall.input && Object.keys(entry.toolCall.input).length) {
      return [{ kind: "json", label: "input", value: entry.toolCall.input }];
    }
    return [];
  }
  if (entry.kind === "observation") {
    const artifacts = entry.observation.detail?.artifacts ?? [];
    const hasCommand = artifacts.some((artifact) => artifact.kind === "command");
    if (descriptor?.command && !hasCommand) {
      return [
        {
          kind: "command",
          command: descriptor.command,
          ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
        },
        ...artifacts,
      ];
    }
    return artifacts;
  }
  if (entry.kind === "operation" && entry.operation.input) {
    return [{ kind: "json", label: "input", value: entry.operation.input }];
  }
  if (entry.kind === "message_part" && (entry.part.text || entry.part.delta)) {
    return [
      {
        kind: "text",
        label: entry.part.kind,
        text: entry.part.text ?? entry.part.delta ?? "",
      },
    ];
  }
  return [];
}

function entryDetailState(entry: FeedEntry) {
  if (entry.kind === "tool_call") {
    return {
      available: entry.toolCall.detailAvailable === true,
      hydrated: Boolean(entry.toolCall.detail?.artifacts?.length),
    };
  }
  if (entry.kind === "observation") {
    return {
      available: entry.observation.detailAvailable === true,
      hydrated: Boolean(entry.observation.detail?.artifacts?.length),
    };
  }
  return { available: false, hydrated: false };
}

type ActivityLabelModel = {
  prefix: string;
  file?: string;
  suffix?: string;
};

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function labelModel(
  descriptor: ConversationActivityDescriptor,
  active: boolean,
): ActivityLabelModel {
  const file = descriptor.files?.[0]?.path;
  const extraFiles = Math.max(0, (descriptor.files?.length ?? 0) - 1);
  const fileSuffix = extraFiles > 0 ? ` and ${extraFiles} more` : "";
  const operationCount = descriptor.operationCount ?? 1;
  switch (descriptor.action) {
    case "command":
      if (descriptor.command) {
        return { prefix: `${active ? "Running" : "Ran"} ${descriptor.command}` };
      }
      if (descriptor.operationCount === undefined) {
        return { prefix: active ? "Running command" : "Ran command" };
      }
      return {
        prefix: active
          ? `Running ${countLabel(operationCount, "command")}`
          : `Ran ${countLabel(operationCount, "command")}`,
      };
    case "file_read":
      return file
        ? { prefix: active ? "Reading " : "Read ", file, suffix: fileSuffix }
        : { prefix: active ? "Reading files" : "Read files" };
    case "file_list":
      return file
        ? { prefix: active ? "Listing files in " : "Listed files in ", file, suffix: fileSuffix }
        : { prefix: active ? "Listing files" : "Listed files" };
    case "file_search": {
      const query = descriptor.query ? ` for “${descriptor.query}”` : "";
      return file
        ? { prefix: active ? "Searching in " : "Searched in ", file, suffix: `${query}${fileSuffix}` }
        : { prefix: `${active ? "Searching files" : "Searched files"}${query}` };
    }
    case "file_create":
      return file
        ? { prefix: active ? "Creating " : "Created ", file, suffix: fileSuffix }
        : { prefix: active ? "Creating files" : "Created files" };
    case "file_edit":
      return file
        ? { prefix: active ? "Editing " : "Edited ", file, suffix: fileSuffix }
        : { prefix: active ? "Editing files" : "Edited files" };
    case "file_delete":
      return file
        ? { prefix: active ? "Deleting " : "Deleted ", file, suffix: fileSuffix }
        : { prefix: active ? "Deleting files" : "Deleted files" };
    case "web_search":
      return {
        prefix: descriptor.query
          ? `${active ? "Searching" : "Searched"} the web for “${descriptor.query}”`
          : active
            ? "Searching the web"
            : "Searched the web",
      };
    case "web_fetch":
      return { prefix: active ? "Fetching web page" : "Fetched web page" };
    case "browser":
      return { prefix: active ? "Using browser" : "Used browser" };
    case "git":
      return { prefix: active ? "Running Git" : "Ran Git command" };
    case "subagent":
      return { prefix: active ? "Running subagent" : "Ran subagent" };
    case "plan":
      return { prefix: active ? "Updating plan" : "Updated plan" };
    case "automation":
      return { prefix: active ? "Running automation" : "Ran automation" };
    case "permission":
      return { prefix: active ? "Requesting input" : "Requested input" };
    case "tool":
      if (descriptor.label === "Wait for command") {
        return { prefix: active ? "Waiting for command" : "Waited for command" };
      }
      if (operationCount > 1) {
        return {
          prefix: `${active ? "Using" : "Used"} ${countLabel(operationCount, "tool")}`,
        };
      }
      return { prefix: descriptor.label ?? (active ? "Using tool" : "Used tool") };
  }
}

function descriptorForEntry(entry: FeedEntry): ConversationActivityDescriptor {
  return entryActivityDescriptor(entry) ?? {
    kind: "tool",
    action: "tool",
    label:
      entry.kind === "operation"
        ? `${entry.operation.name}${entry.operation.target ? ` ${entry.operation.target}` : ""}`
        : entry.kind === "message_part"
          ? entry.part.text ?? entry.part.kind
          : "Activity",
  };
}

export function processActivityLabel(entry: FeedEntry): string {
  const model = labelModel(descriptorForEntry(entry), statusForEntry(entry) === "running");
  return `${model.prefix}${model.file ?? ""}${model.suffix ?? ""}`;
}

function ActivityLabel(props: {
  model: ActivityLabelModel;
  onOpenLocalFile?: ((path: string) => void) | undefined;
}) {
  return (
    <>
      <span className="whitespace-pre">{props.model.prefix}</span>
      {props.model.file ? (
        props.onOpenLocalFile ? (
          <button
            type="button"
            className="min-w-0 truncate underline decoration-[var(--app-muted)] underline-offset-2 outline-none hover:text-[var(--app-fg)] focus-visible:decoration-[var(--app-accent)]"
            title={props.model.file}
            onClick={() => props.onOpenLocalFile?.(props.model.file!)}
          >
            {fileDisplayName(props.model.file)}
          </button>
        ) : (
          <span>{fileDisplayName(props.model.file)}</span>
        )
      ) : null}
      {props.model.suffix ? <span className="whitespace-pre">{props.model.suffix}</span> : null}
    </>
  );
}

function fileDisplayName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").at(-1) || path;
}

function JsonDetail(props: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(props.value, null, 2);
  } catch {
    text = String(props.value);
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
      {text}
    </pre>
  );
}

function FileLink(props: {
  path: string;
  onOpenLocalFile?: ((path: string) => void) | undefined;
  children?: ReactNode;
}) {
  if (!props.onOpenLocalFile) {
    return <span>{props.children ?? props.path}</span>;
  }
  return (
    <button
      type="button"
      className="text-left underline decoration-[var(--app-muted)] underline-offset-2 outline-none hover:text-[var(--app-fg)] focus-visible:decoration-[var(--app-accent)]"
      title={props.path}
      onClick={() => props.onOpenLocalFile?.(props.path)}
    >
      {props.children ?? props.path}
    </button>
  );
}

function CompactArtifacts(props: {
  artifacts: readonly ToolCallArtifact[];
  onOpenLocalFile?: ((path: string) => void) | undefined;
}) {
  return (
    <div className="space-y-3">
      {props.artifacts.map((artifact, index) => {
        if (artifact.kind === "command") {
          return (
            <div key={`command:${index}`}>
              <div className="mb-1 text-[11px] text-[var(--app-hint)]">Shell</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
                $ {artifact.command}
              </pre>
              {artifact.cwd ? (
                <div className="mt-1 text-[11px] text-[var(--app-hint)]">{artifact.cwd}</div>
              ) : null}
            </div>
          );
        }
        if (artifact.kind === "text") {
          return (
            <div key={`text:${artifact.label}:${index}`}>
              <div className="mb-1 text-[11px] text-[var(--app-hint)]">{artifact.label}</div>
              <pre className="rah-scroll-code max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
                {artifact.text}
              </pre>
            </div>
          );
        }
        if (artifact.kind === "json") {
          return <JsonDetail key={`json:${artifact.label}:${index}`} value={artifact.value} />;
        }
        if (artifact.kind === "diff") {
          return <DiffBlock key={`diff:${index}`} text={artifact.text} />;
        }
        if (artifact.kind === "file_refs") {
          return (
            <div key={`files:${index}`} className="space-y-1 font-mono text-xs">
              {artifact.files.map((file) => (
                <div key={file}>
                  <FileLink path={file} onOpenLocalFile={props.onOpenLocalFile} />
                </div>
              ))}
            </div>
          );
        }
        if (artifact.kind === "urls") {
          return (
            <div key={`urls:${index}`} className="space-y-1 text-xs">
              {artifact.urls.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all underline underline-offset-2"
                >
                  {url}
                </a>
              ))}
            </div>
          );
        }
        if (artifact.kind === "image") {
          if (artifact.url) {
            return (
              <img
                key={`image:${index}`}
                src={artifact.url}
                alt={artifact.alt ?? "Activity output"}
                className="max-h-64 max-w-full rounded-md"
              />
            );
          }
          return artifact.path ? (
            <div key={`image:${index}`} className="font-mono text-xs">
              <FileLink path={artifact.path} onOpenLocalFile={props.onOpenLocalFile} />
            </div>
          ) : null;
        }
        return <JsonDetail key={`table:${index}`} value={artifact.rows} />;
      })}
    </div>
  );
}

export function ProcessActivityEntry(props: {
  entry: FeedEntry;
  onLoadDetail?: () => Promise<void> | void;
  onOpenLocalFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const descriptor = descriptorForEntry(props.entry);
  const artifacts = entryArtifacts(props.entry);
  const detailState = entryDetailState(props.entry);
  const status = statusForEntry(props.entry);
  const error =
    props.entry.kind === "tool_call" || props.entry.kind === "observation"
      ? props.entry.error
      : undefined;
  const expandable = artifacts.length > 0 || detailState.available || Boolean(error);
  const label = labelModel(descriptor, status === "running");
  const toggleOpen = () => {
    if (!expandable) return;
    const nextOpen = !open;
    setOpen(nextOpen);
    if (
      nextOpen &&
      detailState.available &&
      !detailState.hydrated &&
      props.onLoadDetail &&
      !detailLoading
    ) {
      setDetailLoading(true);
      void Promise.resolve(props.onLoadDetail()).finally(() => setDetailLoading(false));
    }
  };
  return (
    <div className="min-w-0" data-testid="process-activity-entry">
      <div className="flex min-h-8 w-full min-w-0 items-center gap-2 py-1 text-[13px] leading-5 text-[var(--app-hint)]">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <ConversationActivityActionIcon action={descriptor.action} size={14} />
        </span>
        <span
          className={`flex min-w-0 flex-1 items-baseline truncate ${
            status === "failed" ? "text-[var(--app-danger)]" : ""
          }`}
          title={processActivityLabel(props.entry)}
        >
          <ActivityLabel model={label} onOpenLocalFile={props.onOpenLocalFile} />
        </span>
        {status === "running" ? (
          <LoaderCircle size={13} className="shrink-0 animate-spin" />
        ) : null}
        {status === "failed" ? (
          <AlertTriangle size={13} className="shrink-0 text-[var(--app-danger)]" />
        ) : null}
        {expandable ? (
          <button
            type="button"
            aria-label={open ? "Collapse activity details" : "Expand activity details"}
            aria-expanded={open}
            onClick={toggleOpen}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--app-subtle-bg)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mb-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-code-bg)] px-3 py-2.5 text-[var(--app-fg)]">
          {error ? <div className="mb-2 text-xs text-[var(--app-danger)]">{error}</div> : null}
          {detailLoading ? (
            <div className="mb-2 flex items-center gap-2 text-xs text-[var(--app-hint)]">
              <LoaderCircle size={13} className="animate-spin" />
              <span>Loading details...</span>
            </div>
          ) : null}
          <CompactArtifacts
            artifacts={artifacts}
            onOpenLocalFile={props.onOpenLocalFile}
          />
          {!detailLoading && artifacts.length === 0 && !error ? (
            <div className="text-xs text-[var(--app-hint)]">Details unavailable.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
