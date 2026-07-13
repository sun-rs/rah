import { useEffect, useState } from "react";
import type { ConversationOutputProjection } from "@rah/runtime-protocol";
import { ChevronDown, ExternalLink, Globe2, Image as ImageIcon } from "lucide-react";
import { readHostFile } from "../../api";
import { FileResourceIcon } from "./FileResourceIcon";

const COLLAPSED_OUTPUT_LIMIT = 4;

function imageDataUrl(contentBase64: string, mimeType: string | undefined): string {
  return `data:${mimeType ?? "image/png"};base64,${contentBase64}`;
}

function OutputImagePreview(props: { output: ConversationOutputProjection }) {
  const [src, setSrc] = useState<string | null>(props.output.url ?? null);

  useEffect(() => {
    if (!props.output.path || props.output.url) {
      setSrc(props.output.url ?? null);
      return;
    }
    let cancelled = false;
    setSrc(null);
    void readHostFile(props.output.path)
      .then((response) => {
        if (!cancelled && response.contentBase64) {
          setSrc(imageDataUrl(response.contentBase64, response.mimeType));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSrc(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.output.path, props.output.url]);

  return src ? (
    <img
      src={src}
      alt=""
      className="h-12 w-16 shrink-0 rounded-md border border-[var(--app-border)] object-cover"
    />
  ) : (
    <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
      <ImageIcon size={18} />
    </div>
  );
}

export function ConversationOutputsCard(props: {
  outputs: readonly ConversationOutputProjection[];
  onOpenLocalFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleOutputs = expanded
    ? props.outputs
    : props.outputs.slice(0, COLLAPSED_OUTPUT_LIMIT);
  const hiddenCount = props.outputs.length - visibleOutputs.length;

  return (
    <div
      className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]"
      data-testid="conversation-turn-outputs"
    >
      <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs font-medium text-[var(--app-hint)]">
        Outputs
      </div>
      <div className="divide-y divide-[var(--app-border)]">
        {visibleOutputs.map((output) => {
          const interactive = Boolean(output.path || output.url);
          const content = (
            <>
              {output.kind === "image" ? (
                <OutputImagePreview output={output} />
              ) : output.path ? (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                  <FileResourceIcon path={output.path} size={17} />
                </div>
              ) : (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                  <Globe2 size={17} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                  {output.label}
                </div>
                <div className="truncate text-[11px] text-[var(--app-hint)]">
                  {output.path ?? output.url ?? output.activity}
                </div>
              </div>
              {interactive ? <ExternalLink size={14} className="shrink-0 text-[var(--app-hint)]" /> : null}
            </>
          );
          if (!interactive) {
            return (
              <div key={output.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                {content}
              </div>
            );
          }
          return (
            <button
              key={output.id}
              type="button"
              className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
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
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 border-t border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
          onClick={() => setExpanded(true)}
        >
          Show {hiddenCount} more
          <ChevronDown size={13} />
        </button>
      ) : null}
    </div>
  );
}
