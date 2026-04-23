import { useEffect, useMemo, useState } from "react";
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
import { buildDiffRows, resolveCodeLanguage } from "./shared";
import { useHighlightedLineHtml } from "./useHighlightedLineHtml";

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
              row.kind === "hunk" ? null : highlightedHtml[highlightedIndex++] ?? null;

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
                      className={`[&_.line]:block ${
                        props.wrapLines
                          ? "[&_.line]:whitespace-pre-wrap [&_.line]:break-words"
                          : "[&_.line]:whitespace-pre"
                      }`}
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
  const progressive = shouldUseProgressiveRender(lines.length, FILE_PROGRESSIVE_RENDER);
  const remainingLines = Math.max(0, lines.length - visibleLines.length);

  return (
    <div className="space-y-2">
      <div className="overflow-auto custom-scrollbar scrollbar-stable rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)]">
        <div className="grid grid-cols-[4rem_minmax(0,1fr)]">
          {visibleLines.map((line, index) => (
            <div key={`${index}-${line}`} className="contents">
              <div className="select-none border-r border-[var(--app-border)] px-3 py-0.5 text-right text-xs font-mono text-[var(--app-hint)]">
                {index + 1}
              </div>
              <div className="px-4 py-0.5 text-xs font-mono text-[var(--code-block-text)]">
                {highlightedHtml[index] ? (
                  <span
                    className={`[&_.line]:block ${
                      props.wrapLines
                        ? "[&_.line]:whitespace-pre-wrap [&_.line]:break-words"
                        : "[&_.line]:whitespace-pre"
                    }`}
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
