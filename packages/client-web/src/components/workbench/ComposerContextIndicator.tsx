import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  readComposerVisualViewportBounds,
  resolveComposerPopoverLayout,
} from "../../composer-popover-layout";
import { useComposerVisualViewportRevision } from "../../hooks/useComposerVisualViewportRevision";

export interface ComposerContextIndicatorDisplay {
  label: string;
  compactLabel: string;
  ariaLabel: string;
  tooltip: string;
  percentUsed: number;
}

const CONTEXT_TOOLTIP_WIDTH_PX = 288;
const CONTEXT_TOOLTIP_HEIGHT_PX = 64;

export function ComposerContextIndicator(props: {
  display: ComposerContextIndicatorDisplay;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});
  const visualViewportRevision = useComposerVisualViewportRevision(open);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      return;
    }
    const measuredHeight =
      tooltipRef.current?.getBoundingClientRect().height ??
      CONTEXT_TOOLTIP_HEIGHT_PX;
    const layout = resolveComposerPopoverLayout({
      anchor: triggerRef.current.getBoundingClientRect(),
      viewport: readComposerVisualViewportBounds(),
      desiredWidth: CONTEXT_TOOLTIP_WIDTH_PX,
      desiredHeight: measuredHeight,
      maximumHeight: measuredHeight,
      minimumUsableHeight: measuredHeight,
      padding: 12,
      gap: 8,
      horizontalAlignment: "center",
    });
    setTooltipStyle({
      left: layout.left,
      top: layout.top,
      width: layout.width,
    });
  }, [open, props.display.tooltip, visualViewportRevision, tooltipStyle.width]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !tooltipRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <span
      className="rah-chat-composer-secondary inline-flex shrink-0"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") {
          setOpen(true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex h-10 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] md:h-9 lg:h-8"
        aria-label={props.display.ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-composer-control="context"
        data-composer-focus-preserve="true"
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <span
          className="relative h-[18px] w-[18px] rounded-full"
          style={{
            background: `conic-gradient(var(--app-hint) ${props.display.percentUsed}%, color-mix(in srgb, var(--app-hint) 20%, transparent) 0)`,
          }}
          aria-hidden="true"
        >
          <span className="absolute inset-[3px] rounded-full bg-[var(--app-bg)]" />
        </span>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              data-testid="composer-context-tooltip"
              data-composer-focus-preserve="true"
              className="fixed z-[110] max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-left text-xs leading-5 text-[var(--app-fg)] shadow-lg"
              style={tooltipStyle}
            >
              <span className="block text-[var(--app-hint)]">Context window</span>
              <span className="block font-medium">{props.display.tooltip}</span>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
