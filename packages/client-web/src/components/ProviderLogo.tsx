import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import { implementedProviderLogoRegistry } from "../assets/provider-logos/registry";
import { providerLabel } from "../types";

type ProviderName = SessionSummary["session"]["provider"] | StoredSessionRef["provider"];

const PROVIDER_FALLBACK_LABEL: Record<ProviderName, string> = {
  codex: "Cx",
  claude: "Cl",
  kimi: "Ki",
  gemini: "Gm",
  opencode: "Op",
  custom: "Cu",
};

export function ProviderLogo(props: {
  provider: ProviderName;
  className?: string;
  variant?: "card" | "bare";
}) {
  const label = providerLabel(props.provider);
  const variant = props.variant ?? "card";
  const sizeClassName = props.className ?? "h-5 w-5";
  const baseClassName =
    variant === "bare"
      ? `inline-flex shrink-0 items-center justify-center overflow-hidden ${sizeClassName}`
      : `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] dark:bg-[#27272a] ${sizeClassName}`;
  const imageClassName =
    variant === "bare"
      ? "h-full w-full object-contain"
      : "h-full w-full object-contain p-0.5";

  if (props.provider === "opencode") {
    return (
      <span className={baseClassName} title={label}>
        <img src={implementedProviderLogoRegistry.opencodeLight} alt={`${label} logo`} className={imageClassName} />
      </span>
    );
  }

  const logo =
    props.provider === "codex"
      ? implementedProviderLogoRegistry.codex
      : props.provider === "claude"
        ? implementedProviderLogoRegistry.claude
        : props.provider === "kimi"
          ? implementedProviderLogoRegistry.kimi
          : props.provider === "gemini"
            ? implementedProviderLogoRegistry.gemini
            : undefined;
  if (logo) {
    return (
      <span className={baseClassName} title={label}>
        <img src={logo} alt={`${label} logo`} className={imageClassName} />
      </span>
    );
  }

  return (
    <span className={`${baseClassName} text-[10px] font-bold text-[var(--app-hint)]`} title={label}>
      {PROVIDER_FALLBACK_LABEL[props.provider]}
    </span>
  );
}
