import { FileText, X } from "lucide-react";
import type { ComposerAttachmentItem } from "../hooks/useComposerAttachments";

export function ComposerAttachmentBadge(props: {
  items: readonly ComposerAttachmentItem[];
  onRemove?: ((index: number) => void) | undefined;
  className?: string | undefined;
  layout?: "row" | "stack" | undefined;
}) {
  if (props.items.length === 0) {
    return null;
  }

  const stacked = props.layout === "stack";

  return (
    <div
      className={`${
        stacked
          ? "flex max-h-28 max-w-full flex-col items-start gap-1 overflow-x-hidden overflow-y-auto pr-1"
          : "flex max-w-full items-center gap-1.5 overflow-x-auto overflow-y-visible pb-1"
      } ${props.className ?? ""}`}
      aria-label={`${props.items.length} attached ${props.items.length === 1 ? "file" : "files"}`}
    >
      {props.items.map((item, index) => (
        <div
          key={item.attachment.id}
          className={`relative z-0 flex shrink-0 items-center gap-1.5 rounded-lg border-2 border-sky-500/35 bg-sky-500/10 px-1.5 text-xs text-sky-800 shadow-sm dark:border-sky-400/35 dark:bg-sky-400/12 dark:text-sky-100 ${
            stacked ? "h-8 max-w-full" : "h-9 max-w-44"
          }`}
          title={item.attachment.name}
        >
          {item.previewUrl ? (
            <img
              src={item.previewUrl}
              alt=""
              className="h-6 w-6 shrink-0 rounded object-cover"
              draggable={false}
            />
          ) : (
            <FileText size={16} className="shrink-0" />
          )}
          <span className="min-w-0 truncate">{item.attachment.name}</span>
          {props.onRemove ? (
            <button
              type="button"
              className="icon-click-feedback ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 transition-colors hover:bg-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900"
              onClick={() => props.onRemove?.(index)}
              aria-label={`Remove ${item.attachment.name}`}
              title="Remove attachment"
            >
              <X size={9} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
