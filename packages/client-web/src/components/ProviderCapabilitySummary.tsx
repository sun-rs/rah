import React from "react";
import type { ProviderModelCatalog, SessionSummary } from "@rah/runtime-protocol";
import {
  resolveConfigOptionPreviewRows,
  resolveSessionConfigPreviewRows,
} from "../provider-capabilities";

export function ProviderCapabilitySummary(props: {
  catalog: ProviderModelCatalog | null | undefined;
  summary?: SessionSummary | null | undefined;
  selectedModelId?: string | null | undefined;
  compact?: boolean;
}) {
  if (!props.catalog && !props.summary) {
    return null;
  }

  const sessionOptionRows = resolveSessionConfigPreviewRows(props.summary);
  const optionRows = sessionOptionRows.length > 0
    ? sessionOptionRows
    : props.catalog
      ? resolveConfigOptionPreviewRows({
          catalog: props.catalog,
          summary: props.summary,
          selectedModelId: props.selectedModelId,
        })
      : [];
  if (optionRows.length === 0) {
    return null;
  }

  return (
    <div
      className={
        props.compact
          ? "flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--app-hint)]"
          : "flex flex-col gap-1 text-[11px] text-[var(--app-hint)]"
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[var(--app-hint)]">Options</span>
        {optionRows.map((row) => (
          <span
            key={row.id}
            className="rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[var(--app-fg)]"
            title={[
              row.choiceCount > 0 ? `${row.choiceCount} choices` : null,
              row.currentValue !== null ? `current: ${row.currentValue}` : null,
              row.defaultValue !== null ? `default: ${row.defaultValue}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {row.label}
            {row.currentValue !== null ? `: ${row.currentValue}` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
