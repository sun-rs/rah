import { useMemo } from "react";
import type { ProviderDiagnostic } from "@rah/runtime-protocol";
import { ProviderLogo } from "./ProviderLogo";

export type ProviderChoice = "codex" | "claude" | "opencode";

export interface ProviderOption {
  value: ProviderChoice;
  label: string;
}

export const KNOWN_PROVIDER_OPTIONS: ProviderOption[] = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "opencode", label: "OpenCode" },
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
 * ProviderSelector - Quiet grouped selector with one persistent selected item.
 *
 * Modes:
 * - "grid": For empty states. 3-column grid for core running providers.
 * - "icons": Dense icon-only row for constrained panes.
 */
export function ProviderSelector(props: {
  value: ProviderChoice;
  onChange: (value: ProviderChoice) => void;
  diagnostics?: ProviderDiagnostic[];
  mode?: "grid" | "icons";
  touch?: boolean;
}) {
  const { value, onChange, diagnostics, mode = "grid", touch = false } = props;

  const diagnosticsMap = useMemo(() => {
    const map = new Map<string, ProviderDiagnostic>();
    for (const d of diagnostics ?? []) {
      map.set(d.provider, d);
    }
    return map;
  }, [diagnostics]);
  if (mode === "icons") {
    return (
      <div
        className={`provider-choice-module mx-auto grid w-full max-w-[24rem] grid-cols-3 gap-0 p-0 ${
          touch ? "h-12" : "h-9"
        }`}
        data-provider-selector="module"
        data-touch={touch ? "true" : "false"}
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
              className={`provider-choice-option provider-choice-option-icon-only inline-flex min-w-0 items-center justify-center transition-colors ${
                touch ? "h-12" : "h-9"
              } ${
                selected ? "is-selected" : ""
              }`}
              aria-label={option.label}
              title={option.label}
            >
              <ProviderLogo
                provider={option.value}
                variant="bare"
                className={touch ? "h-[22px] w-[22px]" : "h-[18px] w-[18px]"}
              />
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

  /* Empty state selector: a quiet module with one persistent selected item. */
  return (
    <div
      className={`provider-choice-module mx-auto grid w-full max-w-none grid-cols-3 gap-0 p-0 sm:max-w-[24rem] ${
        touch ? "h-12" : "h-9"
      }`}
      data-provider-selector="module"
      data-touch={touch ? "true" : "false"}
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
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.value)}
            className={`
              provider-choice-option provider-choice-option-with-label group inline-flex min-w-0 items-center justify-center gap-1.5
              px-1.5 text-[13px] font-medium leading-none
              transition-colors duration-200 ease-out
              ${touch ? "h-12" : "h-9"}
              ${selected ? "is-selected" : ""}
            `}
          >
            <ProviderLogo
              provider={option.value}
              variant="bare"
              className={touch ? "h-[22px] w-[22px] shrink-0" : "h-4 w-4 shrink-0"}
            />

            <span className="provider-choice-label-text hidden whitespace-nowrap sm:inline-block">
              {option.label}
            </span>

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
