import type { SessionInputAnnotation } from "@rah/runtime-protocol";
import { MessageSquareText, X } from "lucide-react";

export function ComposerAnnotationBadge(props: {
  items: readonly SessionInputAnnotation[];
  onClear?: (() => void) | undefined;
  className?: string | undefined;
}) {
  if (props.items.length === 0) {
    return null;
  }

  return (
    <div className={`group/annotations relative -mb-2 flex w-fit max-w-full pb-2 ${props.className ?? ""}`}>
      <div className="inline-flex h-9 max-w-full items-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm font-medium text-[var(--app-fg)] shadow-sm">
        <MessageSquareText size={14} className="mr-1.5 shrink-0 text-[var(--app-hint)]" />
        <span className="whitespace-nowrap">{props.items.length} 条注释</span>
        {props.onClear ? (
          <button
            type="button"
            className="icon-click-feedback ml-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            onClick={props.onClear}
            aria-label="移除全部注释"
            title="移除全部注释"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div
        className="pointer-events-auto absolute bottom-full left-0 z-50 hidden w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-left shadow-xl group-hover/annotations:block group-focus-within/annotations:block"
        role="tooltip"
      >
        <div className="max-h-[min(18rem,45dvh)] space-y-3 overflow-y-auto rah-scroll-panel rah-scroll-panel-y">
          {props.items.map((item, index) => (
            <div key={item.id} className="grid grid-cols-[1.5rem_1fr] gap-2">
              <span className="pt-0.5 text-xs tabular-nums text-[var(--app-hint)]">
                {index + 1}.
              </span>
              <div className="min-w-0">
                <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">
                  所选文本
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-5 text-[var(--app-fg)]">
                  {item.text}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
