import { SquareTerminal } from "lucide-react";
import { SegmentedButton, SegmentedButtonLabel, SegmentedControl } from "../components/SegmentedControl";
import { SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS } from "../components/segmented-control-styles";
import { ConversationHeaderPanelToggleButton } from "../components/workbench/shells/ConversationHeader";
import type { InspectorTab } from "./shared";

export function InspectorHeader(props: {
  workspaceRoot: string;
  activeTab: InspectorTab;
  changeCount: number;
  outputCount: number;
  sourceCount: number;
  resourceIndexing: boolean;
  onTabChange: (tab: InspectorTab) => void;
  onOpenTerminal?: () => void;
  onClosePanel?: () => void;
}) {
  const resourceCount = (count: number) =>
    props.resourceIndexing ? (count > 0 ? `${count}+` : "…") : String(count);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--app-fg)]">Inspector</div>
          <div className="truncate text-xs text-[var(--app-hint)]" title={props.workspaceRoot}>
            {props.workspaceRoot}
          </div>
        </div>
        {props.onOpenTerminal ? (
          <button
            type="button"
            className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
            onClick={props.onOpenTerminal}
            aria-label="Open terminal"
            title="Open terminal"
          >
            <SquareTerminal size={16} />
          </button>
        ) : null}
        {props.onClosePanel ? (
          <ConversationHeaderPanelToggleButton
            onClick={props.onClosePanel}
            ariaLabel="Collapse inspector"
            title="Collapse inspector"
            open
          />
        ) : null}
      </div>
      <div className="shrink-0 px-3 py-2">
        <div className="min-w-0">
          <SegmentedControl
            size="compact"
            className="!grid w-full grid-cols-4 gap-0.5"
            role="tablist"
            ariaLabel="Inspector sections"
          >
            <SegmentedButton
              size="compact"
              selected={props.activeTab === "changes"}
              selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
              className="min-w-0 px-1.5"
              onClick={() => props.onTabChange("changes")}
              role="tab"
              aria-selected={props.activeTab === "changes"}
            >
              <SegmentedButtonLabel size="compact" className="block truncate">
                Changes {props.changeCount > 0 ? `(${props.changeCount})` : ""}
              </SegmentedButtonLabel>
            </SegmentedButton>
            <SegmentedButton
              size="compact"
              selected={props.activeTab === "outputs"}
              selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
              className="min-w-0 px-1.5"
              onClick={() => props.onTabChange("outputs")}
              role="tab"
              aria-selected={props.activeTab === "outputs"}
              title="Files and media explicitly generated or delivered by this conversation"
            >
              <SegmentedButtonLabel size="compact" className="block truncate">
                Outputs ({resourceCount(props.outputCount)})
              </SegmentedButtonLabel>
            </SegmentedButton>
            <SegmentedButton
              size="compact"
              selected={props.activeTab === "sources"}
              selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
              className="min-w-0 px-1.5"
              onClick={() => props.onTabChange("sources")}
              role="tab"
              aria-selected={props.activeTab === "sources"}
              title="Attachments, web pages, and external references recorded in provider history; the session does not need to run in RAH"
            >
              <SegmentedButtonLabel size="compact" className="block truncate">
                Sources ({resourceCount(props.sourceCount)})
              </SegmentedButtonLabel>
            </SegmentedButton>
            <SegmentedButton
              size="compact"
              selected={props.activeTab === "files"}
              selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
              className="min-w-0 px-1.5"
              onClick={() => props.onTabChange("files")}
              role="tab"
              aria-selected={props.activeTab === "files"}
            >
              <SegmentedButtonLabel size="compact" className="block truncate">Files</SegmentedButtonLabel>
            </SegmentedButton>
          </SegmentedControl>
        </div>
      </div>
    </>
  );
}
