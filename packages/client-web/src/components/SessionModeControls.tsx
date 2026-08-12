import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  BadgeCheck,
  Check,
  ChevronDown,
  Hand,
  ListTodo,
  Settings2,
  Shield,
  ShieldAlert,
} from "lucide-react";
import type { SessionModeChoice } from "../session-mode-ui";
import {
  readComposerVisualViewportBounds,
  resolveComposerPopoverLayout,
} from "../composer-popover-layout";
import { useComposerVisualViewportRevision } from "../hooks/useComposerVisualViewportRevision";
import { OverlayScrollArea } from "./OverlayScrollArea";

function isElevatedAccessMode(mode: SessionModeChoice | undefined): boolean {
  if (!mode) return false;
  const identity = `${mode.id} ${mode.label}`.toLowerCase();
  return (
    identity.includes("danger-full-access") ||
    identity.includes("full access") ||
    identity.includes("bypass") ||
    identity.includes("yolo")
  );
}

function isAutomaticAccessMode(mode: SessionModeChoice): boolean {
  const identity = `${mode.id} ${mode.label}`.toLowerCase();
  return identity.includes("auto") || identity.includes("guardian");
}

function isCustomAccessMode(mode: SessionModeChoice): boolean {
  const identity = `${mode.id} ${mode.label}`.toLowerCase();
  return identity.includes("custom") || identity.includes("config.toml");
}

function isPlanningAccessMode(mode: SessionModeChoice): boolean {
  const identity = `${mode.id} ${mode.label}`.toLowerCase();
  return identity.includes("plan");
}

function accessModeIcon(mode: SessionModeChoice | undefined) {
  if (!mode) return Shield;
  if (isElevatedAccessMode(mode)) return ShieldAlert;
  if (isPlanningAccessMode(mode)) return ListTodo;
  if (isCustomAccessMode(mode)) return Settings2;
  if (isAutomaticAccessMode(mode)) return BadgeCheck;
  return Hand;
}

export function SessionModeControls(props: {
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  disabled?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  variant?: "compact" | "toolbar" | "composer";
  onOpen?: (() => void) | undefined;
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
}) {
  const accessMenuRef = useRef<HTMLDivElement | null>(null);
  const accessButtonRef = useRef<HTMLButtonElement | null>(null);
  const accessPanelRef = useRef<HTMLDivElement | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessPanelStyle, setAccessPanelStyle] = useState<CSSProperties>({});
  const visualViewportRevision = useComposerVisualViewportRevision(accessOpen);
  const variant = props.variant ?? (props.compact ? "compact" : "toolbar");
  const compact = variant === "compact";
  const composer = variant === "composer";

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
    const desiredHeight = props.accessModes.length * 40 + 12;
    const layout = resolveComposerPopoverLayout({
      anchor: rect,
      viewport: readComposerVisualViewportBounds(),
      desiredWidth: Math.max(rect.width, composer ? 320 : 220),
      desiredHeight,
      maximumHeight: composer ? 420 : 320,
      minimumUsableHeight: 180,
    });

    setAccessPanelStyle({
      left: layout.left,
      top: layout.top,
      width: layout.width,
      height: layout.height,
    });
  }, [
    accessOpen,
    composer,
    props.accessModes.length,
    variant,
    visualViewportRevision,
  ]);

  if (!composer && props.accessModes.length === 0 && !props.planModeAvailable) {
    return null;
  }
  const compactControlClassName =
    "h-9 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-xs text-[var(--app-fg)]";
  const toolbarAccessClassName = props.iconOnly
    ? "icon-click-feedback relative inline-flex h-10 w-10 md:h-9 md:w-9 lg:h-8 lg:w-8 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 text-[11px] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
    : "relative inline-flex h-10 min-[700px]:h-9 lg:h-8 w-10 min-[700px]:w-[7.25rem] shrink-0 items-center justify-center min-[700px]:justify-start gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-0 min-[700px]:px-2.5 text-[11px] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]";
  const showAccessSelect = props.accessModes.length > 0 || composer;
  const selectedAccessMode =
    props.accessModes.find((mode) => mode.id === props.selectedAccessModeId);
  const selectedAccessLabel = selectedAccessMode?.label ?? "Permissions";
  const selectedAccessDisplayLabel = selectedAccessLabel.split(" · ")[0] ?? selectedAccessLabel;
  const elevatedAccess = isElevatedAccessMode(selectedAccessMode);
  const SelectedAccessIcon = accessModeIcon(selectedAccessMode);
  const composerAccessClassName = `rah-composer-permission-trigger icon-click-feedback relative inline-flex h-10 md:h-8 lg:h-7 min-w-0 shrink items-center gap-1 md:gap-0.5 rounded-full border border-transparent bg-transparent text-[13px] leading-[18px] transition-colors hover:bg-[var(--app-subtle-bg)] aria-expanded:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40 ${
    props.iconOnly
      ? "w-10 justify-center px-0 md:w-8 lg:w-7"
      : "max-w-[9.5rem] justify-start px-2 md:px-1.5"
  } ${
    elevatedAccess
      ? "text-orange-600 dark:text-orange-400"
      : "text-[var(--app-fg)]"
  }`;
  const toggleAccessOpen = () => {
    setAccessOpen((current) => {
      if (!current) {
        props.onOpen?.();
      }
      return !current;
    });
  };

  return (
    <div
      ref={accessMenuRef}
      className={
        compact
          ? "flex w-full items-center gap-1.5"
          : composer
            ? "rah-composer-mode-controls flex min-w-0 items-center gap-0.5"
            : "flex items-center gap-1.5 min-h-8 md:min-h-9"
      }
      data-icon-only={composer && props.iconOnly ? "true" : "false"}
    >
      {showAccessSelect ? (
        variant === "compact" ? (
          props.iconOnly ? (
            <button
              ref={accessButtonRef}
              type="button"
              disabled={props.disabled}
              className="icon-click-feedback relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
              title={selectedAccessLabel}
              aria-haspopup="listbox"
              aria-expanded={accessOpen}
              onClick={toggleAccessOpen}
            >
              <span className="sr-only">Session mode</span>
              <Shield size={13} />
            </button>
          ) : (
            <button
              ref={accessButtonRef}
              type="button"
              className={`${compactControlClassName} inline-flex min-w-0 flex-1 items-center justify-start gap-2 transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50`}
              title={selectedAccessLabel}
              aria-label={`Session mode ${selectedAccessLabel}`}
              disabled={props.disabled}
              onClick={toggleAccessOpen}
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
        ) : composer ? (
          <div className="relative min-w-0 shrink-0">
            <button
              ref={accessButtonRef}
              type="button"
              className={composerAccessClassName}
              title={selectedAccessLabel}
              disabled={props.disabled}
              onClick={toggleAccessOpen}
              aria-haspopup="listbox"
              aria-expanded={accessOpen}
              data-composer-control="permissions"
            >
              <span className="sr-only">Session mode</span>
              <SelectedAccessIcon
                size={15}
                strokeWidth={1.8}
                className={`h-[15px] w-[15px] shrink-0 md:h-3.5 md:w-3.5 ${
                  elevatedAccess ? "" : "text-[var(--app-hint)]"
                }`}
              />
              {props.iconOnly ? null : (
                <span className="rah-composer-control-label rah-composer-permission-label min-w-0 truncate text-left">
                  {selectedAccessDisplayLabel}
                </span>
              )}
            </button>
          </div>
        ) : (
          <div className="relative shrink-0">
            <button
              ref={accessButtonRef}
              type="button"
              className={toolbarAccessClassName}
              title={selectedAccessLabel}
              disabled={props.disabled}
              onClick={toggleAccessOpen}
              aria-haspopup="listbox"
              aria-expanded={accessOpen}
            >
              <span className="sr-only">Session mode</span>
              <Shield size={12} className="shrink-0 text-[var(--app-hint)]" />
              {props.iconOnly ? null : (
                <>
                  <span className="hidden min-w-0 flex-1 truncate min-[700px]:block">
                    {selectedAccessDisplayLabel}
                  </span>
                  <ChevronDown
                    size={11}
                    className={`hidden shrink-0 text-[var(--app-hint)] transition-transform min-[700px]:block ${
                      accessOpen ? "rotate-180" : ""
                    }`}
                  />
                </>
              )}
            </button>
          </div>
        )
      ) : null}
      {accessOpen
        ? createPortal(
            <div
              ref={accessPanelRef}
              data-session-access-panel="true"
              className="rah-popover-panel fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-xl focus:outline-none"
              style={accessPanelStyle}
              role="listbox"
              aria-label="Session mode"
            >
              <OverlayScrollArea
                className="min-h-0 flex-1"
                viewportClassName="h-full"
                contentClassName="space-y-1 p-1.5"
                scrollAriaLabel="Session mode"
              >
                {props.accessModes.length > 0 ? props.accessModes.map((mode) => {
                  const selected = mode.id === props.selectedAccessModeId;
                  const elevated = isElevatedAccessMode(mode);
                  const ModeIcon = accessModeIcon(mode);
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => {
                        props.onAccessModeChange(mode.id);
                        setAccessOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
                        selected
                          ? "bg-[var(--app-subtle-bg)] font-medium"
                          : "hover:bg-[var(--app-subtle-bg)]/70"
                      } ${
                        elevated
                          ? "text-orange-600 dark:text-orange-400"
                          : "text-[var(--app-fg)]"
                      }`}
                      role="option"
                      aria-selected={selected}
                    >
                      <ModeIcon
                        size={16}
                        strokeWidth={1.8}
                        className={`mt-0.5 shrink-0 ${
                          elevated ? "" : "text-[var(--app-hint)]"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">{mode.label}</span>
                      {selected ? (
                        <Check
                          size={15}
                          className={`mt-0.5 shrink-0 ${
                            elevated ? "" : "text-[var(--app-success)]"
                          }`}
                        />
                      ) : null}
                    </button>
                  );
                }) : (
                  <div className="px-2.5 py-2 text-sm text-[var(--app-hint)]">
                    Loading permissions…
                  </div>
                )}
              </OverlayScrollArea>
            </div>,
            document.body,
          )
        : null}
      {props.planModeAvailable ? (
        variant === "compact" ? (
          <button
            type="button"
            disabled={props.disabled || !props.planModeAvailable}
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
        ) : composer ? (
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onPlanModeToggle(!props.planModeEnabled)}
            className={`rah-composer-plan-toggle inline-flex h-10 md:h-8 lg:h-7 shrink-0 items-center justify-center gap-1 rounded-full border border-transparent bg-transparent text-[13px] leading-[18px] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40 ${
              props.iconOnly ? "w-10 px-0" : "px-2 md:px-1.5"
            } ${
              props.planModeEnabled
                ? "font-semibold text-[var(--app-resource-link)]"
                : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
            }`}
            aria-pressed={props.planModeEnabled}
            title={props.planModeEnabled ? "Disable plan mode" : "Enable plan mode"}
            aria-label="Plan mode"
            data-composer-control="plan"
            data-plan-active={props.planModeEnabled ? "true" : "false"}
          >
            <ListTodo
              size={14}
              strokeWidth={1.8}
              className="rah-composer-plan-icon h-3.5 w-3.5 shrink-0 md:h-[13px] md:w-[13px]"
            />
            <span className="rah-composer-plan-compact-glyph" aria-hidden="true">
              P
            </span>
            {props.iconOnly ? (
              <span className="sr-only">Plan</span>
            ) : (
              <span className="rah-composer-control-label rah-composer-plan-label">Plan</span>
            )}
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
