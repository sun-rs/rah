import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { LayoutGrid, PanelBottomOpen, PanelRightOpen } from "lucide-react";
import {
  CANVAS_GRID_OPTIONS,
  getCanvasGridDimensions,
  type CanvasGridDimensions,
  type CanvasLayoutNode,
  type CanvasSplitAxis,
} from "../../../canvas-layout";
import {
  HEADER_ACTION_ICON_SIZE,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_MENU_ITEM_CLASS,
} from "../header-button-styles";

function CanvasMenuButton(props: {
  ariaLabel: string;
  title: string;
  icon: ReactNode;
  buttonClassName: string;
  panelWidth: number;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  useEffect(() => {
    if (props.disabled) {
      setOpen(false);
    }
  }, [props.disabled]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const pad = 8;
    const gap = 6;
    const width = Math.min(props.panelWidth, window.innerWidth - pad * 2);
    const left = Math.max(pad, Math.min(rect.right - width, window.innerWidth - width - pad));
    const spaceBelow = window.innerHeight - rect.bottom - pad - gap;
    const openBelow = spaceBelow >= 150 || spaceBelow >= rect.top - pad - gap;
    setPanelStyle({
      left,
      width,
      ...(openBelow
        ? { top: rect.bottom + gap }
        : { bottom: window.innerHeight - rect.top + gap }),
    });
  }, [open, props.panelWidth]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={props.buttonClassName}
        disabled={props.disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        aria-label={props.ariaLabel}
        title={props.title}
        aria-expanded={open}
      >
        {props.icon}
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="rah-popover-panel fixed z-[80] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-xl"
              style={panelStyle}
              onClick={(event) => event.stopPropagation()}
            >
              {props.children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function CanvasPaneSplitButton(props: {
  disabled: boolean;
  onSplit: (axis: CanvasSplitAxis) => void;
}) {
  return (
    <CanvasMenuButton
      ariaLabel="Split pane"
      title={props.disabled ? "Canvas supports up to 8 panes" : "Split pane"}
      icon={<PanelRightOpen size={13} />}
      buttonClassName="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:opacity-30"
      panelWidth={168}
      disabled={props.disabled}
    >
      {(close) => (
        <div className="space-y-0.5">
          <button
            type="button"
            className={HEADER_MENU_ITEM_CLASS}
            onClick={() => {
              props.onSplit("horizontal");
              close();
            }}
          >
            <PanelRightOpen size={15} />
            Split right
          </button>
          <button
            type="button"
            className={HEADER_MENU_ITEM_CLASS}
            onClick={() => {
              props.onSplit("vertical");
              close();
            }}
          >
            <PanelBottomOpen size={15} />
            Split below
          </button>
        </div>
      )}
    </CanvasMenuButton>
  );
}

export function CanvasLayoutDesigner(props: {
  layout: CanvasLayoutNode;
  onSelect: (dimensions: CanvasGridDimensions) => void;
}) {
  const current = getCanvasGridDimensions(props.layout);

  return (
    <CanvasMenuButton
      ariaLabel="Design Canvas layout"
      title="Design Canvas layout"
      icon={<LayoutGrid size={HEADER_ACTION_ICON_SIZE} aria-hidden="true" />}
      buttonClassName={HEADER_ICON_BUTTON_CLASS}
      panelWidth={292}
    >
      {(close) => (
        <div>
          <div className="px-2 pb-1.5 pt-1 text-xs font-semibold text-[var(--app-fg)]">
            Canvas layout
          </div>
          <div className="grid grid-cols-3 gap-1.5 px-1.5 pb-1.5" aria-label="Canvas grid dimensions">
            {CANVAS_GRID_OPTIONS.map(({ columns, rows }) => {
              const active = current?.columns === columns && current.rows === rows;
              return (
                <button
                  key={`${columns}x${rows}`}
                  type="button"
                  className={`flex h-16 flex-col items-center justify-center gap-1 rounded-md border text-[10px] transition-colors ${
                    active
                      ? "border-sky-500/70 bg-sky-500/12 text-sky-700 dark:text-sky-300"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:border-sky-400/70 hover:text-[var(--app-fg)]"
                  }`}
                  onClick={() => {
                    props.onSelect({ columns, rows });
                    close();
                  }}
                  aria-label={`${columns} columns by ${rows} rows`}
                  aria-pressed={active}
                  title={`${columns} columns × ${rows} rows`}
                >
                  <span
                    className="grid h-7 w-11 gap-0.5"
                    style={{
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
                    }}
                    aria-hidden="true"
                  >
                    {Array.from({ length: columns * rows }, (_, index) => (
                      <span
                        key={index}
                        className={`rounded-[1px] border ${
                          active
                            ? "border-sky-500/70 bg-sky-500/20"
                            : "border-[var(--app-hint)]/45 bg-[var(--app-bg)]"
                        }`}
                      />
                    ))}
                  </span>
                  <span>{columns} × {rows}</span>
                </button>
              );
            })}
          </div>
          {current ? null : (
            <div className="px-2 pb-1 pt-0.5 text-center text-[10px] text-[var(--app-hint)]">
              Current layout uses custom splits
            </div>
          )}
        </div>
      )}
    </CanvasMenuButton>
  );
}
