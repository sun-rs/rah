import { useMemo } from "react";
import type { ProviderDiagnostic } from "@rah/runtime-protocol";
import { ProviderLogo } from "./ProviderLogo";

export type ProviderChoice = "codex" | "claude" | "opencode";

export interface ProviderOption {
  value: ProviderChoice;
  label: string;
  accentColor: string;
}

export const KNOWN_PROVIDER_OPTIONS: ProviderOption[] = [
  { value: "codex", label: "Codex", accentColor: "#6b7280" },
  { value: "claude", label: "Claude", accentColor: "#f59e0b" },
  { value: "opencode", label: "OpenCode", accentColor: "#6b7280" },
];

export const PROVIDER_OPTIONS: ProviderOption[] = KNOWN_PROVIDER_OPTIONS;

function StatusDot({ status }: { status: ProviderDiagnostic["status"] }) {
  if (status === "ready") {
    return <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />;
  }
  if (status === "missing_binary") {
    return (
      <span className="inline-flex h-2 w-2 rounded-full bg-[var(--app-warning)]" />
    );
  }
  return <span className="inline-flex h-2 w-2 rounded-full bg-[var(--app-danger)]" />;
}

/**
 * ProviderSelector - Flat, horizontal pill design.
 *
 * Modes:
 * - "grid": For empty states. 3-column grid for core running providers.
 * - "rail": Compact inline pill rail with expand animation.
 * - "icons": Dense icon-only row for constrained panes.
 * - "dialog": Dense 3-column grid for modals.
 */
export function ProviderSelector(props: {
  value: ProviderChoice;
  onChange: (value: ProviderChoice) => void;
  diagnostics?: ProviderDiagnostic[];
  mode?: "grid" | "rail" | "icons" | "dialog";
}) {
  const { value, onChange, diagnostics, mode = "grid" } = props;

  const diagnosticsMap = useMemo(() => {
    const map = new Map<string, ProviderDiagnostic>();
    for (const d of diagnostics ?? []) {
      map.set(d.provider, d);
    }
    return map;
  }, [diagnostics]);
  const selectedOptionIndex = Math.max(
    0,
    PROVIDER_OPTIONS.findIndex((option) => option.value === value),
  );

  if (mode === "rail") {
    return (
      <div className="provider-choice-rail" role="toolbar" aria-label="Provider selection">
        {PROVIDER_OPTIONS.map((option, index) => {
          const selected = value === option.value;
          const diagnostic = diagnosticsMap.get(option.value);
          return (
            <div key={option.value} className="provider-choice-slot">
              {index > 0 ? (
                <span className="provider-choice-separator" aria-hidden="true" />
              ) : null}
              <button
                type="button"
                onClick={() => onChange(option.value)}
                className={`provider-choice-chip ${selected ? "is-selected" : ""}`}
                data-provider={option.value}
                aria-pressed={selected}
                aria-label={option.label}
                title={option.label}
              >
                <span className="provider-choice-icon">
                  <ProviderLogo provider={option.value} variant="bare" className="h-7 w-7" />
                </span>
                <span className="provider-choice-label">
                  <span className="flex items-center gap-1.5">
                    {option.label}
                    {diagnostic && !selected && <StatusDot status={diagnostic.status} />}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  if (mode === "icons") {
    return (
      <div
        className="grid grid-cols-3 gap-1.5"
        role="radiogroup"
        aria-label="Provider selection"
      >
        {PROVIDER_OPTIONS.map((option) => {
          const selected = value === option.value;
          const diagnostic = diagnosticsMap.get(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={`relative inline-flex h-8 min-w-0 items-center justify-center rounded-lg border transition-colors ${
                selected
                  ? "border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                  : "border-transparent bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:border-[var(--app-border)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
              }`}
              aria-label={option.label}
              title={option.label}
            >
              <ProviderLogo provider={option.value} variant="bare" className="h-4.5 w-4.5" />
              {!selected && diagnostic ? (
                <span className="absolute right-1 top-1 scale-75">
                  <StatusDot status={diagnostic.status} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  const isDialog = mode === "dialog";

  if (!isDialog) {
    /* Empty state selector: a centered, compact segmented rail. */
    return (
      <div
        className="relative mx-auto grid h-10 w-full max-w-none grid-cols-3 rounded-xl bg-[var(--app-subtle-bg)] p-1 sm:max-w-[24rem]"
        role="radiogroup"
        aria-label="Provider selection"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 left-1 top-1 w-[calc(33.333333%_-_0.166667rem)] rounded-[8px] border border-[var(--app-border)] bg-[var(--app-bg)] transition-transform duration-200 ease-out dark:bg-[var(--app-subtle-bg)]"
          style={{
            transform: `translateX(${selectedOptionIndex * 100}%)`,
          }}
        />
        {PROVIDER_OPTIONS.map((option) => {
          const selected = value === option.value;
          const diagnostic = diagnosticsMap.get(option.value);

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={`
                group relative z-10 inline-flex min-w-0 items-center justify-center gap-1.5
                rounded-lg px-1.5 text-[13px] font-medium leading-none
                transition-colors duration-200 ease-out
                ${
                  selected
                    ? "text-[var(--app-fg)]"
                    : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                }
              `}
            >
              <ProviderLogo
                provider={option.value}
                variant="bare"
                className="h-4 w-4 shrink-0"
              />

              <span className="hidden truncate sm:inline">{option.label}</span>

              {!selected && diagnostic ? (
                <span className="hidden shrink-0 scale-75 sm:inline">
                  <StatusDot status={diagnostic.status} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-3 gap-2.5"
      role="radiogroup"
      aria-label="Provider selection"
    >
      {PROVIDER_OPTIONS.map((option) => {
        const selected = value === option.value;
        const diagnostic = diagnosticsMap.get(option.value);

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`
              group relative inline-flex items-center justify-center gap-2.5
              rounded-xl transition-all duration-300 ease-out
              px-3 py-2
              ${
                selected
                  ? "bg-[var(--app-bg)] text-[var(--app-fg)] border border-[var(--app-border)] shadow-sm -translate-y-px dark:bg-[var(--app-subtle-bg)] dark:shadow-none dark:border-[var(--app-border)] dark:translate-y-0"
                  : "bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] hover:shadow-sm hover:-translate-y-px hover:border hover:border-[var(--app-border)] dark:hover:bg-[var(--app-subtle-bg)]/80 dark:hover:shadow-none dark:hover:translate-y-0"
              }
            `}
          >
            {/* Left accent indicator when selected */}
            {selected && (
              <span
                className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full dark:!bg-[var(--app-muted)]"
                style={{ backgroundColor: option.accentColor }}
              />
            )}

            {/* Logo */}
            <ProviderLogo
              provider={option.value}
              variant="bare"
              className="h-5 w-5"
            />

            {/* Label */}
            <span className="text-sm font-medium leading-none tracking-tight">
              {option.label}
            </span>

            {/* Status dot */}
            {!selected && diagnostic ? <StatusDot status={diagnostic.status} /> : null}
          </button>
        );
      })}
    </div>
  );
}
