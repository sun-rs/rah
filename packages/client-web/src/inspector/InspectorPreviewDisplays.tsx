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
import {
  buildImageDataUrl,
  parseDelimitedTable,
  parseNotebookPreview,
} from "./file-preview-utils";
import { buildDiffRows, resolveCodeLanguage } from "./shared";
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
}) {
  const language = useMemo(() => resolveCodeLanguage(props.path), [props.path]);
  const [visibleRowCount, setVisibleRowCount] = useState(() =>
    getInitialVisibleCount(props.rows.length, DIFF_PROGRESSIVE_RENDER),
  );

  useEffect(() => {
    setVisibleRowCount(getInitialVisibleCount(props.rows.length, DIFF_PROGRESSIVE_RENDER));
  }, [props.rows]);

  const visibleRows = useMemo(() => props.rows.slice(0, visibleRowCount), [props.rows, visibleRowCount]);
  const highlightableLines = useMemo(
    () => visibleRows.filter((row) => row.kind !== "hunk").map((row) => row.text),
    [visibleRows],
  );
  const highlightableContent = useMemo(() => highlightableLines.join("\n"), [highlightableLines]);
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
  const canUseHighlightedRows = highlightedHtml.length === highlightableLines.length;
  const progressive = shouldUseProgressiveRender(props.rows.length, DIFF_PROGRESSIVE_RENDER);
  const remainingRows = Math.max(0, props.rows.length - visibleRows.length);

  let highlightedIndex = 0;

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
        <div>
          {visibleRows.map((row) => {
            const toneClassName =
              row.kind === "add"
                ? "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]"
                : row.kind === "remove"
                  ? "bg-[var(--diff-remove-bg)] text-[var(--diff-remove-text)]"
                  : row.kind === "hunk"
                    ? "bg-[var(--diff-header-bg)] text-[var(--app-hint)] font-semibold"
                    : "bg-[var(--app-bg)] text-[var(--diff-context-text)]";
            const highlightedRowHtml =
              row.kind === "hunk" || !canUseHighlightedRows
                ? null
                : highlightedHtml[highlightedIndex++] ?? null;

            return (
              <div key={row.key} className={`grid grid-cols-[4rem_2rem_minmax(0,1fr)] ${toneClassName}`}>
                <div className="select-none border-r border-[var(--app-border)] px-3 py-0.5 text-right text-xs font-mono opacity-70">
                  {row.lineNumber ?? ""}
                </div>
                <div className="select-none border-r border-[var(--app-border)] px-2 py-0.5 text-center text-xs font-mono">
                  {row.sign || " "}
                </div>
                <div className="px-3 py-0.5 text-xs font-mono">
                  {highlightedRowHtml ? (
                    <span
                      className={highlightedLineClassName(props.wrapLines)}
                      dangerouslySetInnerHTML={{ __html: highlightedRowHtml }}
                    />
                  ) : (
                    <span className={props.wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>
                      {row.text || " "}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {progressive && remainingRows > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
          <span>
            Showing {visibleRows.length.toLocaleString()} of {props.rows.length.toLocaleString()} diff lines.
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleRowCount((current) => getNextVisibleCount(current, props.rows.length, DIFF_PROGRESSIVE_RENDER))
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

export function FileContentDisplay(props: { content: string; path: string; wrapLines: boolean }) {
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
    <div className="space-y-2">
      <div className="overflow-auto rah-scroll-code scrollbar-stable rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)]">
        <div className="grid grid-cols-[4rem_minmax(0,1fr)]">
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
            onClick={() => setMode("preview")}
            role="tab"
            aria-selected={mode === "preview"}
          >
            <SegmentedButtonLabel size="compact">Preview</SegmentedButtonLabel>
          </SegmentedButton>
          <SegmentedButton
            size="compact"
            selected={mode === "source"}
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
