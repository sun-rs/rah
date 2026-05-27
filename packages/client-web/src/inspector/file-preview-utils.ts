import type {
  NotebookPreviewCell,
  NotebookPreviewData,
} from "@rah/runtime-protocol";

export type FilePreviewKind = "image" | "table" | "notebook" | "markdown" | "text";

export type ParsedDelimitedTable = {
  delimiter: "," | "\t";
  rows: string[][];
  truncated: boolean;
};

export type { NotebookPreviewCell };
export type ParsedNotebookPreview = NotebookPreviewData;

const MAX_TABLE_ROWS = 250;
const MAX_TABLE_COLUMNS = 32;
const MAX_NOTEBOOK_CELLS = 80;
const MAX_NOTEBOOK_OUTPUT_CHARS = 2000;

export function resolveFilePreviewKind(path: string, mimeType: string | undefined): FilePreviewKind {
  const lowerPath = path.toLowerCase();
  const lowerMime = mimeType?.toLowerCase() ?? "";
  if (
    lowerMime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg)$/.test(lowerPath)
  ) {
    return "image";
  }
  if (
    lowerMime === "text/csv" ||
    lowerMime === "text/tab-separated-values" ||
    /\.(csv|tsv)$/.test(lowerPath)
  ) {
    return "table";
  }
  if (lowerMime === "application/x-ipynb+json" || lowerPath.endsWith(".ipynb")) {
    return "notebook";
  }
  if (lowerMime === "text/markdown" || /\.(md|markdown)$/.test(lowerPath)) {
    return "markdown";
  }
  return "text";
}

export function buildImageDataUrl(options: {
  content: string;
  contentBase64?: string;
  mimeType?: string;
  path: string;
}): string | null {
  const mimeType = options.mimeType || inferImageMimeType(options.path);
  if (!mimeType?.startsWith("image/")) {
    return null;
  }
  if (options.contentBase64) {
    return `data:${mimeType};base64,${options.contentBase64}`;
  }
  if (mimeType === "image/svg+xml" && options.content) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(options.content)}`;
  }
  return null;
}

function inferImageMimeType(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return undefined;
}

export function parseDelimitedTable(path: string, content: string): ParsedDelimitedTable {
  const delimiter = path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;
  let rowTruncated = false;

  const pushCell = () => {
    if (currentRow.length < MAX_TABLE_COLUMNS) {
      currentRow.push(currentCell);
    } else {
      rowTruncated = true;
    }
    currentCell = "";
  };

  const pushRow = () => {
    pushCell();
    rows.push(currentRow);
    currentRow = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (char === "\"") {
      if (inQuotes && content[index + 1] === "\"") {
        currentCell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      pushCell();
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && content[index + 1] === "\n") {
        index += 1;
      }
      pushRow();
      if (rows.length >= MAX_TABLE_ROWS) {
        return { delimiter, rows, truncated: true };
      }
      continue;
    }
    currentCell += char;
  }

  if (currentCell || currentRow.length > 0) {
    pushRow();
  }

  return { delimiter, rows, truncated: rowTruncated };
}

export function parseNotebookPreview(content: string): ParsedNotebookPreview {
  const parsed = JSON.parse(content) as {
    cells?: Array<{
      cell_type?: unknown;
      execution_count?: unknown;
      source?: unknown;
      outputs?: unknown;
    }>;
    metadata?: unknown;
  };
  const rawCells = Array.isArray(parsed.cells) ? parsed.cells : [];
  const language = resolveNotebookLanguage(parsed.metadata);
  const cells = rawCells.slice(0, MAX_NOTEBOOK_CELLS).map((cell) => {
    const executionCount =
      typeof cell.execution_count === "number" || cell.execution_count === null
        ? cell.execution_count
        : undefined;
    const outputSummary = summarizeNotebookOutputs(cell.outputs);
    return {
      type: typeof cell.cell_type === "string" ? cell.cell_type : "cell",
      source: normalizeNotebookText(cell.source),
      ...(executionCount !== undefined ? { executionCount } : {}),
      ...(outputSummary ? { outputSummary } : {}),
    };
  });
  return {
    cells,
    truncated: rawCells.length > cells.length,
    ...(language ? { language } : {}),
  };
}

function resolveNotebookLanguage(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  const languageInfo =
    record.language_info && typeof record.language_info === "object"
      ? (record.language_info as Record<string, unknown>)
      : undefined;
  const kernelspec =
    record.kernelspec && typeof record.kernelspec === "object"
      ? (record.kernelspec as Record<string, unknown>)
      : undefined;
  return normalizeNotebookLanguageName(languageInfo?.name ?? kernelspec?.language);
}

function normalizeNotebookLanguageName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("python")) return "python";
  if (["js", "javascript", "node", "nodejs"].includes(normalized)) return "javascript";
  if (["ts", "typescript"].includes(normalized)) return "typescript";
  if (["bash", "sh", "shell", "zsh"].includes(normalized)) return "bash";
  if (["json", "markdown", "rust", "toml", "yaml", "html", "css", "sql"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "yml") return "yaml";
  return undefined;
}

function normalizeNotebookText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry : "")).join("");
  }
  return "";
}

function summarizeNotebookOutputs(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const output of value) {
    if (!output || typeof output !== "object") {
      continue;
    }
    const record = output as Record<string, unknown>;
    const streamText = normalizeNotebookText(record.text);
    if (streamText) {
      chunks.push(streamText);
      continue;
    }
    const traceback = normalizeNotebookText(record.traceback);
    if (traceback) {
      chunks.push(traceback);
      continue;
    }
    const data = record.data;
    if (data && typeof data === "object") {
      const dataRecord = data as Record<string, unknown>;
      const plainText = normalizeNotebookText(dataRecord["text/plain"]);
      if (plainText) {
        chunks.push(plainText);
      }
    }
  }
  const summary = chunks.join("\n").trim();
  if (!summary) {
    return undefined;
  }
  return summary.length > MAX_NOTEBOOK_OUTPUT_CHARS
    ? `${summary.slice(0, MAX_NOTEBOOK_OUTPUT_CHARS)}\n...`
    : summary;
}
