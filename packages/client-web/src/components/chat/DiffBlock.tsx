import { useMemo } from "react";

type DiffLine = { type: "add" | "remove" | "context" | "header"; text: string };

function parseDiffLines(text: string): DiffLine[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line): DiffLine[] => {
      if (
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        return [{ type: "header", text: line }];
      }
      if (line.startsWith("@@") || line.startsWith("\\ No newline")) {
        return [{ type: "header", text: line }];
      }
      if (line.startsWith("+")) {
        return [{ type: "add", text: line }];
      }
      if (line.startsWith("-")) {
        return [{ type: "remove", text: line }];
      }
      return [{ type: "context", text: line }];
    });
}

export function DiffBlock({ text }: { text: string }) {
  const lines = useMemo(() => parseDiffLines(text), [text]);
  if (lines.length === 0) return null;
  return (
    <div className="diff-viewer">
      {lines.map((line, index) => (
        <div key={`${line.type}:${index}`} className={`diff-line ${line.type}`}>
          <span className="diff-line-text">{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
