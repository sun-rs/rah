import { useEffect, useMemo, useState } from "react";
import type { NotebookPreviewData } from "@rah/runtime-protocol";
import {
  DIFF_HIGHLIGHT_LIMITS,
  DIFF_PROGRESSIVE_RENDER,
  FILE_HIGHLIGHT_LIMITS,
  FILE_PROGRESSIVE_RENDER,
  getInitialVisibleCount,
  getNextVisibleCount,
  shouldHighlightPreview,
  shouldUseProgressiveRender,
} from "../inspector-performance";
import { MarkdownRenderer } from "../components/chat/MarkdownRenderer";
import {
  SegmentedButton,
  SegmentedButtonLabel,
  SegmentedControl,
} from "../components/SegmentedControl";
import { SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS } from "../components/segmented-control-styles";
import {
  buildImageDataUrl,
  parseDelimitedTable,
  parseNotebookPreview,
} from "./file-preview-utils";
import {
  buildDiffRows,
  buildSplitDiffRows,
  resolveCodeLanguage,
  type DiffLayout,
  type SplitDiffCell,
} from "./shared";
import { useHighlightedLineHtml } from "./useHighlightedLineHtml";

function highlightedLineClassName(wrapLines: boolean): string {
  return `block [&_.line]:block ${
    wrapLines
      ? "whitespace-pre-wrap break-words [&_.line]:whitespace-pre-wrap [&_.line]:break-words"
      : "whitespace-pre [&_.line]:whitespace-pre"
  }`;
}

export function DiffDisplay(props: {
  rows: ReturnType<typeof buildDiffRows>;
  path: string;
  wrapLines: boolean;
  layout: DiffLayout;
  fillAvailable?: boolean;
}) {
  const language = useMemo(() => resolveCodeLanguage(props.path), [props.path]);
  const splitRows = useMemo(() => buildSplitDiffRows(props.rows), [props.rows]);
  const totalRowCount = props.layout === "split" ? splitRows.length : props.rows.length;
  const [visibleRowCount, setVisibleRowCount] = useState(() =>
    getInitialVisibleCount(totalRowCount, DIFF_PROGRESSIVE_RENDER),
  );

  useEffect(() => {
    setVisibleRowCount(getInitialVisibleCount(totalRowCount, DIFF_PROGRESSIVE_RENDER));
  }, [props.layout, props.rows, totalRowCount]);

  const visibleUnifiedRows = useMemo(
    () => props.rows.slice(0, visibleRowCount),
    [props.rows, visibleRowCount],
  );
  const visibleSplitRows = useMemo(
    () => splitRows.slice(0, visibleRowCount),
    [splitRows, visibleRowCount],
  );
  const highlightableEntries = useMemo(
    () =>
      props.layout === "unified"
        ? visibleUnifiedRows.flatMap((row) =>
            row.kind === "hunk" ? [] : [{ key: row.key, text: row.text }],
          )
        : visibleSplitRows.flatMap((row) =>
            row.kind === "hunk"
              ? []
              : [row.before, row.after].flatMap((cell) =>
                  cell ? [{ key: cell.key, text: cell.text }] : [],
                ),
          ),
    [props.layout, visibleSplitRows, visibleUnifiedRows],
  );
  const highlightableLines = useMemo(
    () => highlightableEntries.map((entry) => entry.text),
    [highlightableEntries],
  );
  const highlightableContent = useMemo(
    () => highlightableLines.join("\n"),
    [highlightableLines],
  );
  const shouldHighlight = shouldHighlightPreview(
    language,
    highlightableLines.length,
    highlightableContent.length,
    DIFF_HIGHLIGHT_LIMITS,
  );
  const highlightedHtml = useHighlightedLineHtml(
    shouldHighlight ? highlightableContent : null,
    shouldHighlight ? language : null,
  );
  const highlightedByKey = useMemo(() => {
    if (highlightedHtml.length !== highlightableEntries.length) {
      return new Map<string, string>();
    }
    return new Map(
      highlightableEntries.map((entry, index) => [entry.key, highlightedHtml[index] ?? ""]),
    );
  }, [highlightableEntries, highlightedHtml]);
  const progressive = shouldUseProgressiveRender(totalRowCount, DIFF_PROGRESSIVE_RENDER);
  const visibleRowsLength =
    props.layout === "split" ? visibleSplitRows.length : visibleUnifiedRows.length;
  const remainingRows = Math.max(0, totalRowCount - visibleRowsLength);

  const renderCodeText = (key: string, text: string) => {
    const highlightedRowHtml = highlightedByKey.get(key);
    return highlightedRowHtml ? (
      <span
        className={highlightedLineClassName(props.wrapLines)}
        dangerouslySetInnerHTML={{ __html: highlightedRowHtml }}
      />
    ) : (
      <span className={props.wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>
        {text || " "}
      </span>
    );
  };

  const renderSplitCell = (cell: SplitDiffCell | null, side: "before" | "after") => {
    if (!cell) {
      return (
        <div
          className={`diff-split-empty min-h-[1.5rem] border-[var(--diff-border)] ${
            side === "before" ? "border-r" : ""
          }`}
          aria-hidden="true"
        />
      );
    }
    const toneClassName =
      cell.kind === "add"
        ? "diff-row-add bg-[var(--diff-add-bg)]"
        : cell.kind === "remove"
          ? "diff-row-remove bg-[var(--diff-remove-bg)]"
          : "bg-[var(--app-bg)]";
    const markerClassName =
      cell.kind === "add"
        ? "bg-[var(--diff-add-gutter-bg)] text-[var(--diff-add-text)]"
        : cell.kind === "remove"
          ? "bg-[var(--diff-remove-gutter-bg)] text-[var(--diff-remove-text)]"
          : "text-[var(--diff-gutter-text)]";
    return (
      <div
        className={`grid min-w-0 ${
          props.wrapLines
            ? "grid-cols-[3.5rem_minmax(0,1fr)]"
            : "grid-cols-[3.5rem_max-content]"
        } ${toneClassName} ${side === "before" ? "border-r border-[var(--diff-border)]" : ""}`}
      >
        <div
          className={`select-none border-r border-[var(--diff-border)] px-2 py-0.5 text-right text-xs font-mono ${markerClassName}`}
        >
          {cell.lineNumber}
        </div>
        <div className="px-3 py-0.5 text-xs font-mono text-[var(--diff-context-text)]">
          {renderCodeText(cell.key, cell.text)}
        </div>
      </div>
    );
  };

  return (
    <div className={props.fillAvailable ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2"}>
      <div
        className={`${props.fillAvailable ? "min-h-0 flex-1 overflow-auto" : "overflow-x-auto"} overscroll-contain rah-scroll-code scrollbar-stable rounded-md border border-[var(--diff-border)] bg-[var(--app-bg)]`}
        data-testid="inspector-diff-scroll"
        data-diff-layout={props.layout}
      >
        {props.layout === "split" ? (
          <div
            className={`grid grid-cols-2 ${
              props.wrapLines ? "w-full min-w-full" : "w-max min-w-[44rem]"
            }`}
            data-testid="inspector-split-diff-grid"
          >
            {visibleSplitRows.map((row) =>
              row.kind === "hunk" ? (
                <div
                  key={row.key}
                  className="col-span-2 border-y border-[var(--diff-border)] bg-[var(--diff-header-bg)] px-3 py-1 text-xs font-mono font-semibold text-[var(--diff-gutter-text)] first:border-t-0"
                >
                  {row.text}
                </div>
              ) : (
                <div key={row.key} className="contents">
                  {renderSplitCell(row.before, "before")}
                  {renderSplitCell(row.after, "after")}
                </div>
              ),
            )}
          </div>
        ) : (
          <div className={props.wrapLines ? "min-w-full" : "w-max min-w-full"}>
            {visibleUnifiedRows.map((row) => {
              const toneClassName =
                row.kind === "add"
                  ? "diff-row-add bg-[var(--diff-add-bg)]"
                  : row.kind === "remove"
                    ? "diff-row-remove bg-[var(--diff-remove-bg)]"
                    : row.kind === "hunk"
                      ? "bg-[var(--diff-header-bg)] text-[var(--diff-gutter-text)] font-semibold"
                      : "bg-[var(--app-bg)] text-[var(--diff-context-text)]";
              const markerClassName =
                row.kind === "add"
                  ? "bg-[var(--diff-add-gutter-bg)] text-[var(--diff-add-text)]"
                  : row.kind === "remove"
                    ? "bg-[var(--diff-remove-gutter-bg)] text-[var(--diff-remove-text)]"
                    : "text-[var(--diff-gutter-text)]";

              return (
                <div
                  key={row.key}
                  className={`grid min-w-full ${
                    props.wrapLines
                      ? "grid-cols-[4rem_2rem_minmax(0,1fr)]"
                      : "grid-cols-[4rem_2rem_max-content]"
                  } ${toneClassName}`}
                >
                  <div className={`select-none border-r border-[var(--diff-border)] px-3 py-0.5 text-right text-xs font-mono ${markerClassName}`}>
                    {row.lineNumber ?? ""}
                  </div>
                  <div className={`select-none border-r border-[var(--diff-border)] px-2 py-0.5 text-center text-xs font-mono ${markerClassName}`}>
                    {row.sign || " "}
                  </div>
                  <div className="px-3 py-0.5 text-xs font-mono text-[var(--diff-context-text)]">
                    {row.kind === "hunk" ? row.text : renderCodeText(row.key, row.text)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {progressive && remainingRows > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
          <span>
            Showing {visibleRowsLength.toLocaleString()} of {totalRowCount.toLocaleString()} diff rows.
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleRowCount((current) => getNextVisibleCount(current, totalRowCount, DIFF_PROGRESSIVE_RENDER))
            }
            className="rounded-md bg-[var(--app-bg)] px-2.5 py-1 text-[var(--app-fg)] transition-colors hover:bg-[var(--app-border)]"
          >
            Load {Math.min(DIFF_PROGRESSIVE_RENDER.step, remainingRows).toLocaleString()} more
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function FileContentDisplay(props: {
  content: string;
  path: string;
  wrapLines: boolean;
  fillAvailable?: boolean;
}) {
  const lines = useMemo(() => props.content.split("\n"), [props.content]);
  const language = useMemo(() => resolveCodeLanguage(props.path), [props.path]);
  const [visibleLineCount, setVisibleLineCount] = useState(() =>
    getInitialVisibleCount(lines.length, FILE_PROGRESSIVE_RENDER),
  );

  useEffect(() => {
    setVisibleLineCount(getInitialVisibleCount(lines.length, FILE_PROGRESSIVE_RENDER));
  }, [lines.length, props.content]);

  const visibleLines = useMemo(() => lines.slice(0, visibleLineCount), [lines, visibleLineCount]);
  const visibleContent = useMemo(() => visibleLines.join("\n"), [visibleLines]);
  const shouldHighlight = shouldHighlightPreview(
    language,
    visibleLines.length,
    visibleContent.length,
    FILE_HIGHLIGHT_LIMITS,
  );
  const highlightedHtml = useHighlightedLineHtml(
    shouldHighlight ? visibleContent : null,
    shouldHighlight ? language : null,
  );
  const canUseHighlightedLines = highlightedHtml.length === visibleLines.length;
  const progressive = shouldUseProgressiveRender(lines.length, FILE_PROGRESSIVE_RENDER);
  const remainingLines = Math.max(0, lines.length - visibleLines.length);

  return (
    <div className={props.fillAvailable ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2"}>
      <div className={`${props.fillAvailable ? "min-h-0 flex-1" : ""} overflow-auto rah-scroll-code scrollbar-stable rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)]`}>
        <div
          className={`grid min-w-full ${
            props.wrapLines
              ? "grid-cols-[4rem_minmax(0,1fr)]"
              : "w-max grid-cols-[4rem_max-content]"
          }`}
          data-testid="inspector-file-content-grid"
        >
          {visibleLines.map((line, index) => (
            <div key={`${index}-${line}`} className="contents">
              <div className="select-none border-r border-[var(--app-border)] px-3 py-0.5 text-right text-xs font-mono text-[var(--app-hint)]">
                {index + 1}
              </div>
              <div className="px-4 py-0.5 text-xs font-mono text-[var(--code-block-text)]">
                {canUseHighlightedLines && highlightedHtml[index] ? (
                  <span
                    className={highlightedLineClassName(props.wrapLines)}
                    dangerouslySetInnerHTML={{ __html: highlightedHtml[index]! }}
                  />
                ) : (
                  <span className={props.wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>
                    {line || " "}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {progressive && remainingLines > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-[11px] text-[var(--app-hint)]">
          <span>
            Showing {visibleLines.length.toLocaleString()} of {lines.length.toLocaleString()} file lines.
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleLineCount((current) => getNextVisibleCount(current, lines.length, FILE_PROGRESSIVE_RENDER))
            }
            className="rounded-md bg-[var(--app-bg)] px-2.5 py-1 text-[var(--app-fg)] transition-colors hover:bg-[var(--app-border)]"
          >
            Load {Math.min(FILE_PROGRESSIVE_RENDER.step, remainingLines).toLocaleString()} more
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ImageFilePreview(props: {
  content: string;
  contentBase64?: string;
  mimeType?: string;
  path: string;
  truncated: boolean;
}) {
  const dataUrl = useMemo(
    () =>
      buildImageDataUrl({
        content: props.content,
        ...(props.contentBase64 ? { contentBase64: props.contentBase64 } : {}),
        ...(props.mimeType ? { mimeType: props.mimeType } : {}),
        path: props.path,
      }),
    [props.content, props.contentBase64, props.mimeType, props.path],
  );

  if (!dataUrl) {
    return (
      <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
        This image is unavailable for inline preview.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {props.truncated ? (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[11px] text-[var(--app-hint)]">
          Showing a limited preview of a large image.
        </div>
      ) : null}
      <div className="flex min-h-[16rem] items-center justify-center overflow-auto rah-scroll-code scrollbar-stable rounded-lg border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3">
        <img
          src={dataUrl}
          alt={props.path.split("/").pop() || "Image preview"}
          className="max-h-[68vh] max-w-full object-contain"
        />
      </div>
    </div>
  );
}

export function DelimitedTablePreview(props: { content: string; path: string; truncated: boolean }) {
  const table = useMemo(() => parseDelimitedTable(props.path, props.content), [props.content, props.path]);
  const [header, ...bodyRows] = table.rows;

  if (!header || header.length === 0) {
    return <FileContentDisplay path={props.path} content={props.content || "File is empty."} wrapLines={false} />;
  }

  return (
    <div className="space-y-2">
      {props.truncated || table.truncated ? (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[11px] text-[var(--app-hint)]">
          Showing the first {table.rows.length.toLocaleString()} rows and up to {header.length.toLocaleString()} columns.
        </div>
      ) : null}
      <div className="overflow-auto rah-scroll-code scrollbar-stable rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--app-subtle-bg)] text-[var(--app-fg)]">
            <tr>
              {header.map((cell, index) => (
                <th
                  key={`${index}-${cell}`}
                  className="max-w-[18rem] border-b border-r border-[var(--app-border)] px-3 py-2 font-medium"
                >
                  <span className="block truncate" title={cell}>
                    {cell || `Column ${index + 1}`}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, rowIndex) => (
              <tr key={rowIndex} className={rowIndex % 2 === 0 ? "bg-[var(--app-bg)]" : "bg-[var(--app-subtle-bg)]/45"}>
                {header.map((_, columnIndex) => {
                  const cell = row[columnIndex] ?? "";
                  return (
                    <td
                      key={`${rowIndex}-${columnIndex}`}
                      className="max-w-[20rem] border-b border-r border-[var(--app-border)] px-3 py-1.5 align-top text-[var(--app-fg)]"
                    >
                      <span className="block truncate" title={cell}>
                        {cell}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MarkdownFilePreview(props: {
  content: string;
  path: string;
  truncated: boolean;
  wrapLines: boolean;
}) {
  const [mode, setMode] = useState<"preview" | "source">("preview");

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <SegmentedControl
          size="compact"
          className="inline-flex w-fit gap-1"
          role="tablist"
          ariaLabel="Markdown file view"
        >
          <SegmentedButton
            size="compact"
            selected={mode === "preview"}
            selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
            onClick={() => setMode("preview")}
            role="tab"
            aria-selected={mode === "preview"}
          >
            <SegmentedButtonLabel size="compact">Preview</SegmentedButtonLabel>
          </SegmentedButton>
          <SegmentedButton
            size="compact"
            selected={mode === "source"}
            selectedClassName={SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS}
            onClick={() => setMode("source")}
            role="tab"
            aria-selected={mode === "source"}
          >
            <SegmentedButtonLabel size="compact">Source</SegmentedButtonLabel>
          </SegmentedButton>
        </SegmentedControl>
      </div>
      {props.truncated ? (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[11px] text-[var(--app-hint)]">
          Showing the first part of a large Markdown file.
        </div>
      ) : null}
      {mode === "preview" ? (
        <div className="overflow-auto rah-scroll-code scrollbar-stable rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-3">
          <MarkdownRenderer
            className="prose-chat max-w-none text-sm leading-relaxed text-[var(--app-fg)]"
            content={props.content || "File is empty."}
          />
        </div>
      ) : (
        <FileContentDisplay
          path={props.path}
          content={props.content || "File is empty."}
          wrapLines={props.wrapLines}
        />
      )}
    </div>
  );
}

function NotebookCodeCell(props: { source: string; language?: string }) {
  const language = props.language ?? "python";
  const lines = useMemo(() => props.source.split("\n"), [props.source]);
  const shouldHighlight = shouldHighlightPreview(
    language,
    lines.length,
    props.source.length,
    FILE_HIGHLIGHT_LIMITS,
  );
  const highlightedHtml = useHighlightedLineHtml(
    shouldHighlight ? props.source : null,
    shouldHighlight ? language : null,
  );
  const canUseHighlightedLines = highlightedHtml.length === lines.length;

  return (
    <pre className="overflow-auto rah-scroll-code scrollbar-stable px-3 py-2 text-xs text-[var(--code-block-text)] whitespace-pre font-mono">
      {canUseHighlightedLines ? (
        lines.map((_line, index) => (
          <span
            key={index}
            className={highlightedLineClassName(false)}
            dangerouslySetInnerHTML={{ __html: highlightedHtml[index] || " " }}
          />
        ))
      ) : (
        props.source || " "
      )}
    </pre>
  );
}

function NotebookPlainCell(props: { source: string }) {
  return (
    <pre className="overflow-auto rah-scroll-code scrollbar-stable px-3 py-2 text-xs text-[var(--code-block-text)] whitespace-pre font-mono">
      {props.source || " "}
    </pre>
  );
}

export function NotebookPreview(props: {
  content: string;
  path: string;
  truncated: boolean;
  notebookPreview?: NotebookPreviewData;
}) {
  const notebook = useMemo(() => {
    if (props.notebookPreview) {
      return { preview: props.notebookPreview, error: null as string | null };
    }
    try {
      return { preview: parseNotebookPreview(props.content), error: null as string | null };
    } catch (error) {
      return {
        preview: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [props.content, props.notebookPreview]);

  if (notebook.error || !notebook.preview) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-warning-bg)] p-2 text-[11px] text-[var(--app-hint)]">
          Notebook preview unavailable{props.truncated ? " because the file is too large to read fully" : ""}.
          Showing JSON source instead.
        </div>
        <FileContentDisplay path={props.path} content={props.content || "File is empty."} wrapLines />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {props.truncated || notebook.preview.truncated || notebook.preview.omittedOutputs ? (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-[11px] text-[var(--app-hint)]">
          {notebook.preview.truncated
            ? `Showing the first ${notebook.preview.cells.length.toLocaleString()} notebook cells.`
            : "Showing notebook cells without large binary output data."}
        </div>
      ) : null}
      {notebook.preview.cells.length === 0 ? (
        <div className="text-sm text-[var(--app-hint)]">This notebook has no cells.</div>
      ) : (
        notebook.preview.cells.map((cell, index) => (
          <div
            key={index}
            className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]"
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1.5 text-[11px] text-[var(--app-hint)]">
              <span className="font-medium uppercase tracking-wide">{cell.type}</span>
              {cell.executionCount !== undefined && cell.executionCount !== null ? (
                <span>In [{cell.executionCount}]</span>
              ) : null}
            </div>
            {cell.type === "markdown" ? (
              <div className="overflow-auto rah-scroll-code scrollbar-stable px-3 py-2">
                <MarkdownRenderer
                  className="prose-chat max-w-none text-sm leading-relaxed text-[var(--app-fg)]"
                  content={cell.source || " "}
                />
              </div>
            ) : (
              cell.type === "code" ? (
                <NotebookCodeCell
                  source={cell.source || " "}
                  language={notebook.preview.language ?? "python"}
                />
              ) : (
                <NotebookPlainCell source={cell.source || " "} />
              )
            )}
            {cell.outputSummary ? (
              <pre className="border-t border-[var(--app-border)] bg-[var(--app-code-bg)] px-3 py-2 text-xs text-[var(--app-hint)] whitespace-pre-wrap">
                {cell.outputSummary}
              </pre>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
