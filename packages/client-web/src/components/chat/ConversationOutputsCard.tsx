import { useState } from "react";
import type { ConversationOutputProjection } from "@rah/runtime-protocol";
import {
  ChevronDown,
  ChevronRight,
  Globe2,
} from "lucide-react";
import {
  FileResourceIcon,
  fileResourceKind,
  type FileResourceKind,
} from "./FileResourceIcon";
import { LocalImageResource } from "./LocalImageResource";

const COLLAPSED_OUTPUT_LIMIT = 3;

function OutputImagePreview(props: { output: ConversationOutputProjection }) {
  return (
    <LocalImageResource
      mode="compact"
      {...(props.output.path ? { path: props.output.path } : {})}
      {...(props.output.url ? { url: props.output.url } : {})}
      {...(props.output.label ? { alt: props.output.label } : {})}
    />
  );
}

const FILE_KIND_LABELS: Record<FileResourceKind, string> = {
  code: "Code",
  document: "Document",
  image: "Image",
  spreadsheet: "Spreadsheet",
};

function fileExtension(path: string): string | null {
  const basename = path.split("/").pop() ?? path;
  const separator = basename.lastIndexOf(".");
  return separator > 0 && separator < basename.length - 1
    ? basename.slice(separator + 1).toUpperCase()
    : null;
}

function outputTypeLabel(output: ConversationOutputProjection): string {
  if (output.path) {
    const kind = fileResourceKind(output.path);
    const extension = fileExtension(output.path);
    return extension ?? FILE_KIND_LABELS[kind];
  }
  if (output.kind === "url") {
    return "Link";
  }
  return output.activity === "generated" ? "Generated output" : "Output";
}

export function ConversationOutputsCard(props: {
  outputs: readonly ConversationOutputProjection[];
  onOpenLocalFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleOutputs = expanded
    ? props.outputs
    : props.outputs.slice(0, COLLAPSED_OUTPUT_LIMIT);
  const overflowCount = Math.max(0, props.outputs.length - COLLAPSED_OUTPUT_LIMIT);
  const hasOverflow = props.outputs.length > COLLAPSED_OUTPUT_LIMIT;

  return (
    <div
      className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]"
      data-testid="conversation-turn-outputs"
    >
      <div className="divide-y divide-[var(--app-border)]">
        {visibleOutputs.map((output) => {
          const interactive = Boolean(output.path || output.url);
          const content = (
            <>
              {output.kind === "image" ? (
                <OutputImagePreview output={output} />
              ) : output.path ? (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                  <FileResourceIcon path={output.path} size={16} />
                </div>
              ) : (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                  <Globe2 size={16} />
                </div>
              )}
              <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--app-fg)]">
                {output.label}
              </div>
              <span className="shrink-0 text-[11px] font-medium text-[var(--app-hint)]">
                {outputTypeLabel(output)}
              </span>
              {interactive ? (
                <ChevronRight
                  size={13}
                  className="shrink-0 text-[var(--app-hint)] transition-transform group-hover:translate-x-0.5"
                />
              ) : null}
            </>
          );
          if (!interactive) {
            return (
              <div key={output.id} className="flex min-h-11 min-w-0 items-center gap-2.5 px-3 py-1.5">
                {content}
              </div>
            );
          }
          return (
            <button
              key={output.id}
              type="button"
              className="group flex min-h-11 w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:bg-[var(--app-subtle-bg)]"
              title={output.path ?? output.url ?? output.label}
              onClick={() => {
                if (output.path) {
                  props.onOpenLocalFile?.(output.path);
                } else if (output.url) {
                  window.open(output.url, "_blank", "noopener,noreferrer");
                }
              }}
            >
              {content}
            </button>
          );
        })}
      </div>
      {hasOverflow ? (
        <button
          type="button"
          className="flex min-h-9 w-full items-center justify-center gap-1.5 border-t border-[var(--app-border)] px-3 py-1.5 text-[11px] font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : `Show ${overflowCount} more`}
          <ChevronDown
            size={13}
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      ) : null}
    </div>
  );
}
