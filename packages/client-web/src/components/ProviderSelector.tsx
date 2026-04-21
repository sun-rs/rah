import { useMemo } from "react";
import type { ProviderDiagnostic } from "@rah/runtime-protocol";
import { ProviderLogo } from "./ProviderLogo";

export type ProviderChoice = "codex" | "claude" | "kimi" | "gemini" | "opencode";

export interface ProviderOption {
  value: ProviderChoice;
  label: string;
  accentColor: string;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  { value: "codex", label: "Codex", accentColor: "#6b7280" },
  { value: "claude", label: "Claude", accentColor: "#f59e0b" },
  { value: "kimi", label: "Kimi", accentColor: "#9ca3af" },
  { value: "gemini", label: "Gemini", accentColor: "#3b82f6" },
  { value: "opencode", label: "OpenCode", accentColor: "#6b7280" },
];

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
 * - "grid": For empty states. 5-column grid, spacious.
 * - "rail": Compact inline pill rail with expand animation.
 * - "dialog": Dense 3-column grid for modals.
 */
export function ProviderSelector(props: {
  value: ProviderChoice;
  onChange: (value: ProviderChoice) => void;
  diagnostics?: ProviderDiagnostic[];
  mode?: "grid" | "rail" | "dialog";
}) {
  const { value, onChange, diagnostics, mode = "grid" } = props;

  const diagnosticsMap = useMemo(() => {
    const map = new Map<string, ProviderDiagnostic>();
    for (const d of diagnostics ?? []) {
      map.set(d.provider, d);
    }
    return map;
  }, [diagnostics]);

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

  const isDialog = mode === "dialog";

  if (!isDialog) {
    /* Grid cards for empty state — icon+label on desktop, icon-only on mobile */
    return (
      <div
        className="grid grid-cols-5 gap-3"
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
                px-4 py-3
                ${
                  selected
                    ? "bg-[var(--app-bg)] text-[var(--app-fg)] border border-[var(--app-border)] shadow-sm -translate-y-px dark:bg-[var(--app-subtle-bg)] dark:shadow-none dark:border-[var(--app-border)] dark:translate-y-0"
                    : "bg-[var(--app-bg)] sm:bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] hover:shadow-sm hover:-translate-y-px hover:border hover:border-[var(--app-border)] dark:hover:bg-[var(--app-subtle-bg)]/80 dark:hover:shadow-none dark:hover:translate-y-0"
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
                className="h-5.5 w-5.5"
              />

              {/* Label - hidden on mobile */}
              <span className="hidden sm:inline text-sm font-medium leading-none tracking-tight">
                {option.label}
              </span>

              {/* Status dot - hidden on mobile */}
              {!selected && diagnostic ? (
                <span className="hidden sm:inline">
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
