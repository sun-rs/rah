import { useEffect, useMemo, useState } from "react";
import {
  SegmentedButton,
  SegmentedButtonLabel,
  SegmentedControl,
} from "../components/SegmentedControl";
import { SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS } from "../components/segmented-control-styles";
import { buildIsolatedHtmlPreviewDocument } from "./html-file-preview-document";
import { FileContentDisplay } from "./InspectorPreviewDisplays";

export function HtmlFilePreview(props: {
  content: string;
  path: string;
  truncated: boolean;
  wrapLines: boolean;
}) {
  const [mode, setMode] = useState<"preview" | "source">(
    props.truncated ? "source" : "preview",
  );
  const previewDocument = useMemo(
    () =>
      props.truncated
        ? null
        : buildIsolatedHtmlPreviewDocument(props.content),
    [props.content, props.truncated],
  );

  useEffect(() => {
    setMode(props.truncated ? "source" : "preview");
  }, [props.path, props.truncated]);

  const effectiveMode = props.truncated ? "source" : mode;

  return (
    <div className="flex h-full min-h-[16rem] flex-col gap-2">
      <div className="flex shrink-0 justify-end">
        <SegmentedControl
          size="compact"
          className="inline-flex w-fit gap-1"
          role="tablist"
          ariaLabel="HTML file view"
        >
          <SegmentedButton
            size="compact"
            selected={effectiveMode === "preview"}
            selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
            onClick={() => setMode("preview")}
            disabled={props.truncated}
            title={
              props.truncated
                ? "Preview is unavailable because only the beginning of this file was loaded"
                : "Show isolated HTML preview"
            }
            role="tab"
            aria-selected={effectiveMode === "preview"}
          >
            <SegmentedButtonLabel size="compact">Preview</SegmentedButtonLabel>
          </SegmentedButton>
          <SegmentedButton
            size="compact"
            selected={effectiveMode === "source"}
            selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
            onClick={() => setMode("source")}
            role="tab"
            aria-selected={effectiveMode === "source"}
          >
            <SegmentedButtonLabel size="compact">Source</SegmentedButtonLabel>
          </SegmentedButton>
        </SegmentedControl>
      </div>
      {props.truncated ? (
        <div className="shrink-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[11px] text-[var(--app-hint)]">
          This HTML file is too large for a complete preview. Showing its source prefix instead.
        </div>
      ) : null}
      {effectiveMode === "preview" && previewDocument ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--app-border)] bg-white">
          <iframe
            title={`${props.path.split("/").pop() || "HTML"} preview`}
            srcDoc={previewDocument}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="block h-full min-h-[16rem] w-full border-0 bg-white"
            data-testid="inspector-html-preview"
          />
        </div>
      ) : (
        <FileContentDisplay
          path={props.path}
          content={props.content || "File is empty."}
          wrapLines={props.wrapLines}
          fillAvailable
        />
      )}
    </div>
  );
}
