import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal } from "lucide-react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import type { SessionModeChoice } from "../session-mode-ui";
import { SessionModeControls } from "./SessionModeControls";
import { SessionModelControls } from "./SessionModelControls";

export function SessionControlPopover(props: {
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  modeDisabled?: boolean;
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  selectedModelId: string | null;
  selectedReasoningId: string | null;
  modelDisabled?: boolean;
  disabled?: boolean;
  locked?: boolean;
  lockedMessage?: string;
  allowProviderDefault?: boolean;
  showModel: boolean;
  buttonClassName: string;
  align?: "left" | "right";
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
  onModelChange: (modelId: string, defaultReasoningId?: string | null) => void;
  onReasoningChange: (reasoningId: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [lockedNoticeStyle, setLockedNoticeStyle] = useState<CSSProperties | null>(null);
  const hasModes = props.accessModes.length > 0 || props.planModeAvailable;
  const hasModel =
    props.showModel && Boolean(props.modelCatalog || props.modelCatalogLoading);
  const hasControls = hasModes || hasModel;
  const enabled = hasControls && !props.disabled;
  const locked = enabled && props.locked === true;

  useEffect(() => {
    if (props.disabled) {
      setOpen(false);
    }
  }, [props.disabled]);

  useEffect(() => {
    if (locked) {
      setOpen(false);
    }
  }, [locked]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const pad = 8;
    const gap = 6;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(256, viewportWidth - pad * 2);
    const preferredLeft =
      props.align === "right" ? rect.right - width : rect.left;
    const left = Math.max(pad, Math.min(preferredLeft, viewportWidth - width - pad));
    const spaceBelow = viewportHeight - rect.bottom - pad - gap;
    const spaceAbove = rect.top - pad - gap;
    const openBelow = spaceBelow >= 220 || spaceBelow >= spaceAbove;
    const availableHeight = Math.max(120, openBelow ? spaceBelow : spaceAbove);

    setPanelStyle({
      ...(openBelow
        ? { top: rect.bottom + gap }
        : { bottom: viewportHeight - rect.top + gap }),
      left,
      width,
      maxHeight: Math.min(360, availableHeight),
    });
  }, [open, props.align, hasModes, hasModel]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const targetElement =
        target instanceof Element ? target : target.parentElement;
      if (targetElement?.closest("[data-session-model-panel='true']")) return;
      if (targetElement?.closest("[data-session-access-panel='true']")) return;
      if (
        !triggerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!lockedNoticeStyle) return;
    const timeout = window.setTimeout(() => setLockedNoticeStyle(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [lockedNoticeStyle]);

  const showLockedNotice = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 236;
    const pad = 8;
    const left = Math.max(pad, Math.min(rect.left, window.innerWidth - width - pad));
    const top = Math.max(pad, rect.top - 46);
    setLockedNoticeStyle({ top, left, width });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={!enabled}
        onClick={() => {
          if (locked) {
            showLockedNotice();
            return;
          }
          setOpen((current) => !current);
        }}
        className={`${props.buttonClassName} ${
          locked ? "cursor-not-allowed opacity-45 grayscale hover:bg-[var(--app-subtle-bg)]" : ""
        }`}
        title={locked ? props.lockedMessage ?? "Session controls are locked." : "Session control"}
        aria-label="Session control"
        aria-disabled={locked || undefined}
        aria-expanded={open}
      >
        <SlidersHorizontal size={16} />
      </button>
      {lockedNoticeStyle
        ? createPortal(
            <div
              className="rah-popover-panel fixed z-[70] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-xs font-medium text-[var(--app-fg)] shadow-xl"
              style={lockedNoticeStyle}
              role="status"
            >
              {props.lockedMessage ?? "Session controls are locked while this session is busy."}
            </div>,
            document.body,
          )
        : null}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              data-session-control-panel="true"
              className="rah-popover-panel fixed z-50 overflow-visible rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl"
              style={panelStyle}
            >
              <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs font-semibold text-[var(--app-fg)]">
                Session control
              </div>
              <div className="space-y-1.5 p-2">
                {hasModes ? (
                  <SessionModeControls
                    compact
                    accessModes={props.accessModes}
                    selectedAccessModeId={props.selectedAccessModeId}
                    planModeAvailable={props.planModeAvailable}
                    planModeEnabled={props.planModeEnabled}
                    disabled={props.disabled || (props.modeDisabled ?? false)}
                    onAccessModeChange={props.onAccessModeChange}
                    onPlanModeToggle={props.onPlanModeToggle}
                  />
                ) : null}
                {hasModel ? (
                  <SessionModelControls
                    compact
                    catalog={props.modelCatalog}
                    selectedModelId={props.selectedModelId}
                    selectedReasoningId={props.selectedReasoningId}
                    loading={props.modelCatalogLoading}
                    disabled={props.disabled || (props.modelDisabled ?? false)}
                    {...(props.allowProviderDefault !== undefined
                      ? { allowProviderDefault: props.allowProviderDefault }
                      : {})}
                    onModelChange={props.onModelChange}
                    onReasoningChange={props.onReasoningChange}
                  />
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
