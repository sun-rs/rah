import { useEffect, useMemo, useState } from "react";
import type { RahEvent, WorkspaceNode } from "@rah/runtime-protocol";
import { FileText, Folder, PanelRight } from "lucide-react";
import { readWorkspace } from "./api";

function formatEventTimestamp(event: RahEvent): string {
  try {
    const date = new Date(event.ts);
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return event.ts;
  }
}

function isFileChangeObservation(event: RahEvent): boolean {
  if (!event.type.startsWith("observation.")) return false;
  const obs = (event.payload as { observation?: { kind?: string } }).observation;
  if (!obs) return false;
  return ["file.write", "file.edit", "patch.apply", "git.apply"].includes(obs.kind ?? "");
}

function ChangesList(props: { events: RahEvent[] }) {
  const items = useMemo(() => props.events.filter(isFileChangeObservation), [props.events]);
  return (
    <div className="space-y-3">
      {items.length > 0 ? (
        items.map((change, index) => {
          const obs = (change.payload as { observation?: { title?: string; description?: string; path?: string; kind?: string } }).observation;
          return (
            <div
              key={`${change.seq}-${index}`}
              className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-sm font-medium truncate text-[var(--app-fg)]">
                  {obs?.path ?? obs?.title ?? "Change"}
                </div>
                <div className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)] text-[var(--app-hint)]">
                  {obs?.kind ?? "file-change"}
                </div>
              </div>
              {obs?.description ? (
                <div className="mt-1 text-xs text-[var(--app-hint)]">{obs.description}</div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="text-sm text-[var(--app-hint)]">No file changes yet.</div>
      )}
    </div>
  );
}

function FilesList(props: { nodes: WorkspaceNode[]; cwd: string }) {
  const sorted = useMemo(() => {
    return [...props.nodes].sort((a, b) => {
      if (a.kind === b.kind) return a.path.localeCompare(b.path);
      return a.kind === "directory" ? -1 : 1;
    });
  }, [props.nodes]);

  return (
    <div className="space-y-1">
      {sorted.length > 0 ? (
        sorted.map((node) => {
          const depth = node.path.split("/").length - props.cwd.split("/").length;
          const indent = Math.max(0, depth) * 12;
          return (
            <div
              key={node.path}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--app-bg)] transition-colors"
              style={{ paddingLeft: `${indent + 8}px` }}
            >
              {node.kind === "directory" ? (
                <Folder size={14} className="text-[var(--app-hint)] shrink-0" />
              ) : (
                <FileText size={14} className="text-[var(--app-hint)] shrink-0" />
              )}
              <span className={`text-sm truncate ${node.kind === "directory" ? "text-[var(--app-fg)] font-medium" : "text-[var(--app-hint)]"}`}>
                {node.name}
              </span>
            </div>
          );
        })
      ) : (
        <div className="text-sm text-[var(--app-hint)]">No files in workspace.</div>
      )}
    </div>
  );
}

function EventsList(props: { events: RahEvent[] }) {
  return (
    <div className="space-y-2">
      {props.events.length > 0 ? (
        props.events.map((event, index) => {
          const payload = event.payload as Record<string, unknown>;
          let detail: string | null = null;
          if (event.type === "timeline.item.added" || event.type === "timeline.item.updated") {
            const item = (payload.item ?? {}) as { kind?: string; text?: string };
            detail = item.text ?? item.kind ?? null;
          } else if (event.type.startsWith("observation.")) {
            const obs = (payload.observation ?? {}) as { kind?: string; title?: string };
            detail = obs.title ?? obs.kind ?? null;
          } else if (event.type.startsWith("tool.call.")) {
            const tool = (payload.toolCall ?? {}) as { providerToolName?: string };
            detail = tool.providerToolName ?? null;
          } else if (event.type.startsWith("permission.")) {
            const req = (payload.request ?? {}) as { kind?: string; title?: string };
            detail = req.title ?? req.kind ?? null;
          } else if (event.type === "session.state.changed") {
            detail = (payload.state as string | undefined) ?? null;
          } else if (event.type === "turn.input.appended") {
            detail = (payload.text as string | undefined) ?? null;
          } else if (event.type === "turn.failed" || event.type === "session.failed") {
            detail = (payload.error as string | undefined) ?? null;
          }
          return (
            <div
              key={`${event.seq}-${index}`}
              className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-[var(--app-fg)]">{event.type}</div>
                <div className="text-[11px] text-[var(--app-hint)]">
                  {formatEventTimestamp(event)}
                </div>
              </div>
              {detail ? (
                <div className="mt-1 text-xs text-[var(--app-hint)] line-clamp-3">{detail}</div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="text-sm text-[var(--app-hint)]">No events.</div>
      )}
    </div>
  );
}

export function InspectorPane(props: {
  sessionId: string;
  events: RahEvent[];
  onCollapse?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"files" | "changes" | "events">("files");
  const [fileNodes, setFileNodes] = useState<WorkspaceNode[]>([]);
  const [fileCwd, setFileCwd] = useState<string>("");
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFileLoading(true);
    readWorkspace(props.sessionId)
      .then((res) => {
        if (!cancelled) {
          setFileNodes(res.nodes);
          setFileCwd(res.cwd);
          setFileLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.sessionId]);

  const changeCount = useMemo(() => props.events.filter(isFileChangeObservation).length, [props.events]);

  return (
    <div className="h-full flex flex-col">
      <div className="h-14 px-4 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">Inspector</div>
          <div className="text-[11px] text-[var(--app-hint)] truncate">{fileCwd}</div>
        </div>
        {props.onCollapse && (
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
            onClick={props.onCollapse}
            aria-label="Collapse inspector"
            title="Collapse inspector"
          >
            <PanelRight size={16} />
          </button>
        )}
      </div>
      <div className="shrink-0 px-3 py-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-[var(--app-bg)] p-0.5">
          <button
            type="button"
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeTab === "files"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
            }`}
            onClick={() => setActiveTab("files")}
          >
            Files {fileNodes.length > 0 ? `(${fileNodes.length})` : ""}
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeTab === "changes"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
            }`}
            onClick={() => setActiveTab("changes")}
          >
            Changes {changeCount > 0 ? `(${changeCount})` : ""}
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeTab === "events"
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
            }`}
            onClick={() => setActiveTab("events")}
          >
            Events {props.events.length > 0 ? `(${props.events.length})` : ""}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3">
        {activeTab === "files" ? (
          fileLoading ? (
            <div className="text-sm text-[var(--app-hint)]">Loading files…</div>
          ) : (
            <FilesList nodes={fileNodes} cwd={fileCwd} />
          )
        ) : activeTab === "changes" ? (
          <ChangesList events={props.events} />
        ) : (
          <EventsList events={props.events} />
        )}
      </div>
    </div>
  );
}
