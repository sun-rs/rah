import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Shield } from "lucide-react";
import type { SessionModeChoice } from "../session-mode-ui";

export function SessionModeControls(props: {
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  disabled?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  variant?: "compact" | "toolbar";
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
}) {
  const accessMenuRef = useRef<HTMLDivElement | null>(null);
  const accessButtonRef = useRef<HTMLButtonElement | null>(null);
  const accessPanelRef = useRef<HTMLDivElement | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessPanelStyle, setAccessPanelStyle] = useState<CSSProperties>({});
  const variant = props.variant ?? (props.compact ? "compact" : "toolbar");
  const compact = variant === "compact";

  useEffect(() => {
    if (!accessOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !accessMenuRef.current?.contains(target) &&
        !accessPanelRef.current?.contains(target)
      ) {
        setAccessOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccessOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [accessOpen]);

  useLayoutEffect(() => {
    if (!accessOpen || !accessButtonRef.current) return;
    const rect = accessButtonRef.current.getBoundingClientRect();
    const pad = 8;
    const gap = 6;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 220), viewportWidth - pad * 2);
    const left = Math.max(pad, Math.min(rect.left, viewportWidth - width - pad));
    const spaceBelow = viewportHeight - rect.bottom - pad - gap;
    const spaceAbove = rect.top - pad - gap;
    const openBelow = spaceBelow >= 180 || spaceBelow >= spaceAbove;
    const availableHeight = Math.max(96, openBelow ? spaceBelow : spaceAbove);
    const desiredHeight = props.accessModes.length * 40 + 12;

    setAccessPanelStyle({
      ...(openBelow
        ? { top: rect.bottom + gap }
        : { bottom: viewportHeight - rect.top + gap }),
      left,
      width,
      maxHeight: Math.min(320, availableHeight, desiredHeight),
    });
  }, [accessOpen, props.accessModes.length, variant]);

  if (props.accessModes.length === 0 && !props.planModeAvailable) {
    return null;
  }
  const compactControlClassName =
    "h-9 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-xs text-[var(--app-fg)]";
  const toolbarAccessClassName = props.iconOnly
    ? "relative inline-flex h-10 w-10 md:h-9 md:w-9 lg:h-8 lg:w-8 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 text-[11px] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
    : "relative inline-flex h-10 md:h-9 lg:h-8 w-10 md:w-[7.25rem] shrink-0 items-center justify-center md:justify-start gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-0 md:px-2.5 text-[11px] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]";
  const showAccessSelect = props.accessModes.length > 0;
  const selectedAccessLabel =
    props.accessModes.find((mode) => mode.id === props.selectedAccessModeId)?.label ?? "Access";
  const selectedAccessDisplayLabel = selectedAccessLabel.split(" · ")[0] ?? selectedAccessLabel;

  return (
    <div
      ref={accessMenuRef}
      className={compact ? "flex w-full items-center gap-1.5" : "flex items-center gap-1.5 min-h-8 md:min-h-9"}
    >
      {showAccessSelect ? (
        variant === "compact" ? (
          props.iconOnly ? (
            <button
              ref={accessButtonRef}
              type="button"
              disabled={props.disabled}
              onClick={() => setAccessOpen((open) => !open)}
              className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
              title={selectedAccessLabel}
              aria-haspopup="listbox"
              aria-expanded={accessOpen}
            >
              <span className="sr-only">Access mode</span>
              <Shield size={13} />
            </button>
          ) : (
            <button
              ref={accessButtonRef}
              type="button"
              className={`${compactControlClassName} inline-flex min-w-0 flex-1 items-center justify-start gap-2 transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50`}
              title={selectedAccessLabel}
              disabled={props.disabled}
              onClick={() => setAccessOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={accessOpen}
            >
              <Shield size={13} className="shrink-0 text-[var(--app-hint)]" />
              <span className="min-w-0 flex-1 truncate text-left">{selectedAccessDisplayLabel}</span>
              <ChevronDown
                size={12}
                className={`shrink-0 text-[var(--app-hint)] transition-transform ${
                  accessOpen ? "rotate-180" : ""
                }`}
              />
            </button>
          )
        ) : (
          <div className="relative shrink-0">
            <button
              ref={accessButtonRef}
              type="button"
              className={toolbarAccessClassName}
              title={selectedAccessLabel}
              disabled={props.disabled}
              onClick={() => setAccessOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={accessOpen}
            >
              <span className="sr-only">Access mode</span>
              <Shield size={12} className="shrink-0 text-[var(--app-hint)]" />
              {props.iconOnly ? null : (
                <>
                  <span className="hidden min-w-0 flex-1 truncate md:block">
                    {selectedAccessDisplayLabel}
                  </span>
                  <ChevronDown
                    size={11}
                    className={`hidden shrink-0 text-[var(--app-hint)] transition-transform md:block ${
                      accessOpen ? "rotate-180" : ""
                    }`}
                  />
                </>
              )}
            </button>
          </div>
        )
      ) : null}
      {accessOpen && props.accessModes.length > 0
        ? createPortal(
            <div
              ref={accessPanelRef}
              data-session-access-panel="true"
              className="rah-popover-panel fixed z-[60] overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-2xl focus:outline-none"
              style={accessPanelStyle}
              role="listbox"
              aria-label="Access mode"
            >
              {props.accessModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => {
                    props.onAccessModeChange(mode.id);
                    setAccessOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    mode.id === props.selectedAccessModeId
                      ? "bg-[var(--app-subtle-bg)] font-medium text-[var(--app-fg)]"
                      : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/70"
                  }`}
                  role="option"
                  aria-selected={mode.id === props.selectedAccessModeId}
                >
                  <span className="min-w-0 flex-1 truncate">{mode.label}</span>
                  {mode.id === props.selectedAccessModeId ? (
                    <Check size={14} className="shrink-0 text-[var(--app-success)]" />
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
      {props.planModeAvailable ? (
        variant === "compact" ? (
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onPlanModeToggle(!props.planModeEnabled)}
            className={`${compactControlClassName} inline-flex ${
              showAccessSelect ? "w-[4.75rem]" : "w-full"
            } shrink-0 items-center justify-center gap-1.5 rounded-lg transition-colors ${
              props.planModeEnabled
                ? "border-sky-500/40 bg-sky-500/10 font-semibold text-sky-600 dark:text-sky-400"
                : "border-[var(--app-border)] bg-[var(--app-bg)] font-semibold text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            }`}
            aria-pressed={props.planModeEnabled}
            title="Toggle plan mode"
          >
            <span>Plan</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onPlanModeToggle(!props.planModeEnabled)}
            className={`inline-flex h-10 md:h-9 lg:h-8 w-10 md:w-14 lg:w-12 shrink-0 items-center justify-center rounded-full border text-[11px] transition-colors ${
              props.planModeEnabled
                ? "border-sky-500/20 bg-sky-500/12 font-semibold text-sky-700 dark:text-sky-300"
                : "border-[var(--app-border)] bg-[var(--app-bg)] font-semibold text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            }`}
            aria-pressed={props.planModeEnabled}
            title="Toggle plan mode"
          >
            Plan
          </button>
        )
      ) : null}
    </div>
  );
}
