import type { ToolCallArtifact } from "@rah/runtime-protocol";
import { ExternalLink, FolderTree, Image as ImageIcon, Table2 } from "lucide-react";
import { DiffBlock } from "./DiffBlock";

function ArtifactLabel({ label }: { label: string }) {
  return (
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)]">
      {label}
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="code-block">
      <code>{text}</code>
    </pre>
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderTableRows(rows: Array<Record<string, unknown>>) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) {
    return null;
  }
  return (
    <div className="overflow-x-auto custom-scrollbar rounded-lg border border-[var(--app-border)]">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-[var(--app-code-bg)] text-[var(--app-hint)]">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-3 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              className="border-t border-[var(--app-border)] text-[var(--app-fg)]"
            >
              {columns.map((column) => (
                <td key={column} className="px-3 py-2 align-top">
                  <div className="whitespace-pre-wrap break-words">
                    {typeof row[column] === "string"
                      ? (row[column] as string)
                      : formatJson(row[column])}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderArtifact(artifact: ToolCallArtifact, index: number) {
  switch (artifact.kind) {
    case "text":
      return (
        <div key={`${artifact.kind}:${artifact.label}:${index}`}>
          <ArtifactLabel label={artifact.label} />
          <CodeBlock text={artifact.text} />
        </div>
      );
    case "command":
      return (
        <div key={`${artifact.kind}:${artifact.command}:${index}`}>
          <ArtifactLabel label="command" />
          <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-code-bg)] px-3 py-2">
            <div className="font-mono text-xs text-[var(--app-fg)]">{artifact.command}</div>
            {artifact.cwd ? (
              <div className="mt-1 text-xs text-[var(--app-hint)]">{artifact.cwd}</div>
            ) : null}
          </div>
        </div>
      );
    case "diff":
      return (
        <div key={`${artifact.kind}:${artifact.format}:${index}`}>
          <ArtifactLabel label="diff" />
          <DiffBlock text={artifact.text} />
        </div>
      );
    case "file_refs":
      return (
        <div key={`${artifact.kind}:${index}`}>
          <ArtifactLabel label="files" />
          <div className="space-y-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-code-bg)] px-3 py-2">
            {artifact.files.map((file) => (
              <div key={file} className="flex items-start gap-2 text-xs text-[var(--app-fg)]">
                <FolderTree size={14} className="mt-0.5 shrink-0 text-[var(--app-hint)]" />
                <code className="break-all">{file}</code>
              </div>
            ))}
          </div>
        </div>
      );
    case "json":
      return (
        <div key={`${artifact.kind}:${artifact.label}:${index}`}>
          <ArtifactLabel label={artifact.label} />
          <CodeBlock text={formatJson(artifact.value)} />
        </div>
      );
    case "urls":
      return (
        <div key={`${artifact.kind}:${index}`}>
          <ArtifactLabel label="links" />
          <div className="space-y-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-code-bg)] px-3 py-2">
            {artifact.urls.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-start gap-2 break-all text-xs text-[var(--app-fg)] underline underline-offset-2"
              >
                <ExternalLink size={12} className="mt-0.5 shrink-0 text-[var(--app-hint)]" />
                <span>{url}</span>
              </a>
            ))}
          </div>
        </div>
      );
    case "image":
      return (
        <div key={`${artifact.kind}:${artifact.url ?? artifact.path ?? index}`}>
          <ArtifactLabel label="image" />
          <div className="space-y-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-code-bg)] px-3 py-2">
            {artifact.url ? (
              <img
                src={artifact.url}
                alt={artifact.alt ?? "artifact image"}
                className="max-h-64 rounded-lg border border-[var(--app-border)]"
              />
            ) : null}
            {artifact.path ? (
              <div className="flex items-start gap-2 text-xs text-[var(--app-fg)]">
                <ImageIcon size={12} className="mt-0.5 shrink-0 text-[var(--app-hint)]" />
                <code className="break-all">{artifact.path}</code>
              </div>
            ) : null}
          </div>
        </div>
      );
    case "table":
      return (
        <div key={`${artifact.kind}:${artifact.label}:${index}`}>
          <ArtifactLabel label={artifact.label} />
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
              <Table2 size={14} />
              <span>{artifact.rows.length} rows</span>
            </div>
            {renderTableRows(artifact.rows)}
          </div>
        </div>
      );
  }
}

export function ActivityArtifacts(props: { artifacts: ToolCallArtifact[] }) {
  if (props.artifacts.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2">
      {props.artifacts.map((artifact, index) => renderArtifact(artifact, index))}
    </div>
  );
}
