import { useEffect, useRef, useState } from "react";
import type { ProviderKind, TimelineRuntimeModel } from "@rah/runtime-protocol";
import { ProviderLogo } from "../ProviderLogo";
import { providerLabel } from "../../types";

function runtimeModelLabel(runtimeModel: TimelineRuntimeModel): string | null {
  if (!runtimeModel.modelId && !runtimeModel.optionId) {
    return null;
  }
  return [runtimeModel.modelId, runtimeModel.optionId].filter(Boolean).join(" · ");
}

export function AssistantTurnModelMeta(props: {
  provider: ProviderKind;
  runtimeModel?: TimelineRuntimeModel;
}) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const pointerActivatedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const modelLabel = props.runtimeModel ? runtimeModelLabel(props.runtimeModel) : null;

  const toggleFromPointer = () => {
    pointerActivatedRef.current = true;
    setOpen((value) => !value);
    // A normal pointer activation emits click immediately after pointerup. If
    // layout/scroll handling cancels that click (notably in an iOS-sized
    // virtual feed), the guard must not leak into a later keyboard click.
    window.setTimeout(() => {
      pointerActivatedRef.current = false;
    }, 0);
  };

  const toggleFromClick = () => {
    if (pointerActivatedRef.current) {
      pointerActivatedRef.current = false;
      return;
    }
    setOpen((value) => !value);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const fullLabel = [providerLabel(props.provider), modelLabel].filter(Boolean).join(" · ");
  return (
    <span
      ref={rootRef}
      className="relative inline-flex shrink-0"
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          setOpen(true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-[var(--app-hint)] opacity-80 outline-none transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] focus-visible:bg-[var(--app-bg)] focus-visible:text-[var(--app-fg)]"
        aria-label={fullLabel}
        aria-expanded={open}
        data-testid="assistant-turn-model-meta"
        onPointerUp={(event) => {
          if (event.button === 0 && event.pointerType === "touch") {
            toggleFromPointer();
          }
        }}
        onClick={(event) => {
          if (event.detail === 0 || pointerActivatedRef.current) {
            toggleFromClick();
          }
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <ProviderLogo
          provider={props.provider}
          variant="bare"
          className="h-3 w-3"
          showNativeTitle={false}
        />
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1.5 w-max max-w-72 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-left text-xs font-normal leading-4 text-[var(--app-fg)] shadow-lg"
          data-testid="assistant-turn-model-meta-detail"
        >
          <span className="block font-medium">{fullLabel}</span>
          <span className="mt-0.5 block text-[var(--app-hint)]">
            {props.runtimeModel
              ? `Source: ${props.runtimeModel.source ?? "unknown"}`
              : "Model details unavailable"}
          </span>
        </span>
      ) : null}
    </span>
  );
}
