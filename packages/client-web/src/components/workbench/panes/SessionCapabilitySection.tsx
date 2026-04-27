import React from "react";
import type { ProviderModelCatalog, SessionSummary } from "@rah/runtime-protocol";
import { ProviderCapabilitySummary } from "../../ProviderCapabilitySummary";

export function SessionCapabilitySection(props: {
  catalog: ProviderModelCatalog | null | undefined;
  summary?: SessionSummary | null;
  selectedModelId?: string | null;
}) {
  return (
    <div className="mt-2">
      <ProviderCapabilitySummary
        catalog={props.catalog}
        summary={props.summary}
        selectedModelId={props.selectedModelId}
      />
    </div>
  );
}
