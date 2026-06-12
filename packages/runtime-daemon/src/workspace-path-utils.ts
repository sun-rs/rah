import { execFile, spawn } from "node:child_process";
import { promises as fs, readdirSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  NotebookPreviewData,
  SessionFileResponse,
  SessionFileSearchItem,
} from "@rah/runtime-protocol";

const DEFAULT_MAX_READABLE_FILE_BYTES = 1_000_000;
const NOTEBOOK_MAX_READABLE_FILE_BYTES = 8_000_000;
const LARGE_IMAGE_PREVIEW_EDGE_PX = 1600;
const MAX_NOTEBOOK_PREVIEW_CELLS = 80;
const MAX_NOTEBOOK_OUTPUT_CHARS = 2000;
const MAX_WORKSPACE_FILE_SEARCH_RESULTS = 500;
const WORKSPACE_FILE_SEARCH_TIMEOUT_MS = 10_000;

export type ImagePreviewMode = "bounded" | "full";
export type FilePreviewReadOptions = {
  imagePreviewMode?: ImagePreviewMode;
};
export type WorkspaceFileData = Omit<SessionFileResponse, "sessionId">;

async function execFileUtf8(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", ...(options?.cwd ? { cwd: options.cwd } : {}) }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export function getWorkspaceSnapshot(cwd: string) {
  return {
    cwd,
    nodes: readWorkspaceNodes(cwd),
  };
}

export async function searchWorkspaceFilesInDirectoryAsync(
  cwd: string,
  query: string,
  limit = 100,
): Promise<SessionFileSearchItem[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const safeLimit = Math.max(0, Math.min(limit, MAX_WORKSPACE_FILE_SEARCH_RESULTS));
  if (safeLimit === 0) {
    return [];
  }
  try {
    return await searchWorkspaceFilesWithRipgrep(cwd, normalizedQuery, safeLimit);
  } catch {
    return [];
  }
}

async function searchWorkspaceFilesWithRipgrep(
  cwd: string,
  normalizedQuery: string,
  limit: number,
): Promise<SessionFileSearchItem[]> {
  return await new Promise<SessionFileSearchItem[]>((resolve, reject) => {
    const child = spawn("rg", ["--files", "."], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const results: SessionFileSearchItem[] = [];
    let carry = "";
    let settled = false;
    let stoppedEarly = false;

    const finish = (value: SessionFileSearchItem[]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const stopEarly = () => {
      if (stoppedEarly) {
        return;
      }
      stoppedEarly = true;
      child.kill("SIGTERM");
      finish(results);
    };
    const appendMatch = (relativePath: string) => {
      const normalizedPath = normalizeWorkspaceSearchPath(relativePath);
      if (!normalizedPath || !normalizedPath.toLowerCase().includes(normalizedQuery)) {
        return;
      }
      results.push({
        path: normalizedPath,
        name: path.basename(normalizedPath),
        parentPath: path.dirname(normalizedPath) === "." ? "" : path.dirname(normalizedPath),
      });
      if (results.length >= limit) {
        stopEarly();
      }
    };
    const consume = (chunk: string, flush = false) => {
      const lines = `${carry}${chunk}`.split(/\r?\n/);
      carry = flush ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (settled) {
          break;
        }
        appendMatch(line);
      }
      if (flush && carry && !settled) {
        appendMatch(carry);
        carry = "";
      }
    };
    const timeout = setTimeout(() => stopEarly(), WORKSPACE_FILE_SEARCH_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => consume(String(chunk)));
    child.on("error", fail);
    child.on("close", () => {
      if (!settled) {
        consume("", true);
        finish(results);
      }
    });
  });
}

export async function readWorkspaceFileDataAsync(
  cwd: string,
  targetPath: string,
  options?: { scopeRoot?: string } & FilePreviewReadOptions,
): Promise<WorkspaceFileData> {
  const resolvedPath = await resolveWorkspacePathAsync(options?.scopeRoot ?? cwd, targetPath);
  return await readFileDataAtResolvedPathAsync(resolvedPath, options);
}

export async function readHostFileDataAsync(
  targetPath: string,
  options?: FilePreviewReadOptions,
): Promise<WorkspaceFileData> {
  if (!path.isAbsolute(targetPath)) {
    throw new Error("Host file path must be absolute.");
  }
  return await readFileDataAtResolvedPathAsync(path.resolve(targetPath), options);
}

async function readFileDataAtResolvedPathAsync(
  resolvedPath: string,
  options?: FilePreviewReadOptions,
): Promise<WorkspaceFileData> {
  const resolved = await resolveFileLocationPathAsync(resolvedPath);
  const stats = resolved.stats;
  const filePath = resolved.path;
  if (!stats.isFile()) {
    throw new Error("Path is not a file.");
  }
  const buffer = await fs.readFile(filePath);
  const maxReadableBytes = maxReadableFileBytes(filePath);
  const truncated = buffer.byteLength > maxReadableBytes;
  const mimeType = resolvePreviewMimeType(filePath);
  const notebookPreview =
    mimeType === "application/x-ipynb+json"
      ? parseNotebookPreviewData(buffer.toString("utf8"))
      : undefined;
  const contentOverride =
    truncated && notebookPreview ? compactNotebookPreviewContent(notebookPreview) : undefined;
  const contentBuffer = truncated && !contentOverride ? buffer.subarray(0, maxReadableBytes) : buffer;
  const binary = contentOverride ? false : isLikelyBinary(contentBuffer);
  const imageContent =
    !contentOverride && binary && mimeType?.startsWith("image/")
      ? await readImagePreviewContentBase64(filePath, buffer, {
          mimeType,
          truncated,
          mode: options?.imagePreviewMode ?? "bounded",
        })
      : undefined;
  const responseMimeType = imageContent?.mimeType ?? mimeType;
  return {
    path: filePath,
    content: binary ? "" : (contentOverride ?? contentBuffer.toString("utf8")),
    binary,
    sizeBytes: stats.size,
    ...(responseMimeType ? { mimeType: responseMimeType } : {}),
    ...(imageContent ? { contentBase64: imageContent.contentBase64 } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(notebookPreview ? { notebookPreview } : {}),
  };
}

async function readImagePreviewContentBase64(
  filePath: string,
  originalBuffer: Buffer,
  options: {
    mimeType: string;
    truncated: boolean;
    mode: ImagePreviewMode;
  },
): Promise<{ contentBase64: string; mimeType: string } | undefined> {
  if (!options.truncated || options.mode === "full" || options.mimeType === "image/svg+xml") {
    return { contentBase64: originalBuffer.toString("base64"), mimeType: options.mimeType };
  }

  const preview = await tryCreateBoundedImagePreview(filePath);
  if (preview) {
    return preview;
  }

  return { contentBase64: originalBuffer.toString("base64"), mimeType: options.mimeType };
}

async function tryCreateBoundedImagePreview(
  filePath: string,
): Promise<{ contentBase64: string; mimeType: string } | undefined> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "rah-image-preview-"));
  const outPath = path.join(dir, "preview.jpg");
  try {
    await execFileUtf8("sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "80",
      "-Z",
      String(LARGE_IMAGE_PREVIEW_EDGE_PX),
      filePath,
      "--out",
      outPath,
    ]);
    const preview = await fs.readFile(outPath);
    return { contentBase64: preview.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return undefined;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function resolveFileLocationPathAsync(
  resolvedPath: string,
): Promise<{ path: string; stats: Stats }> {
  try {
    return { path: resolvedPath, stats: await fs.stat(resolvedPath) };
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    const strippedPath = stripFileLocationSuffix(resolvedPath);
    if (!strippedPath || strippedPath === resolvedPath) {
      throw error;
    }
    return { path: strippedPath, stats: await fs.stat(strippedPath) };
  }
}

function stripFileLocationSuffix(value: string): string | null {
  const match = /^(.*?):\d+(?::\d+)?$/.exec(value);
  return match?.[1] || null;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function parseNotebookPreviewData(content: string): NotebookPreviewData | undefined {
  try {
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
    let omittedOutputs = false;
    const language = resolveNotebookLanguage(parsed.metadata);
    const cells = rawCells.slice(0, MAX_NOTEBOOK_PREVIEW_CELLS).map((cell) => {
      const executionCount =
        typeof cell.execution_count === "number" || cell.execution_count === null
          ? cell.execution_count
          : undefined;
      const outputSummary = summarizeNotebookOutputs(cell.outputs);
      if (hasNotebookOutputs(cell.outputs) && !outputSummary) {
        omittedOutputs = true;
      }
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
      ...(omittedOutputs ? { omittedOutputs: true } : {}),
    };
  } catch {
    return undefined;
  }
}

function compactNotebookPreviewContent(preview: NotebookPreviewData): string {
  return JSON.stringify(
    {
      cells: preview.cells.map((cell) => ({
        cell_type: cell.type,
        source: cell.source,
        ...(cell.executionCount !== undefined ? { execution_count: cell.executionCount } : {}),
        outputs: cell.outputSummary
          ? [{ output_type: "stream", name: "stdout", text: cell.outputSummary }]
          : [],
      })),
      metadata: preview.language ? { language_info: { name: preview.language } } : {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2,
  );
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

function hasNotebookOutputs(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
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
      const plainText = normalizeNotebookText(
        (data as Record<string, unknown>)["text/plain"],
      );
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

function maxReadableFileBytes(filePath: string): number {
  return path.extname(filePath).toLowerCase() === ".ipynb"
    ? NOTEBOOK_MAX_READABLE_FILE_BYTES
    : DEFAULT_MAX_READABLE_FILE_BYTES;
}

function resolvePreviewMimeType(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".csv":
      return "text/csv";
    case ".tsv":
      return "text/tab-separated-values";
    case ".ipynb":
      return "application/x-ipynb+json";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    default:
      return undefined;
  }
}

export async function readWorkspaceFileFromDirectoryAsync(
  cwd: string,
  targetPath: string,
  options?: { scopeRoot?: string } & FilePreviewReadOptions,
): Promise<SessionFileResponse> {
  return {
    sessionId: "",
    ...(await readWorkspaceFileDataAsync(cwd, targetPath, options)),
  };
}

export async function tryResolveGitRootAsync(cwd: string): Promise<string | null> {
  try {
    const root = (await execFileUtf8("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

export function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return resolved.startsWith("/private/var/") ? resolved.slice("/private".length) : resolved;
}

export function isPathWithinBase(basePath: string, targetPath: string): boolean {
  const resolvedBase = normalizeComparablePath(basePath);
  const resolvedTarget = normalizeComparablePath(targetPath);
  const relativePath = path.relative(resolvedBase, resolvedTarget);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export async function resolveWorkspacePathAsync(cwd: string, targetPath: string): Promise<string> {
  const scopeRoot = path.resolve(cwd);
  const cwdCandidate = tryResolveWithinBase(scopeRoot, targetPath);
  const gitRoot = await tryResolveGitRootAsync(cwd);
  const gitRootCandidate =
    gitRoot && path.resolve(gitRoot) !== scopeRoot ? path.resolve(gitRoot, targetPath) : null;

  if (cwdCandidate && (await pathExistsAsync(cwdCandidate))) {
    await assertExistingPathWithinBaseAsync(scopeRoot, cwdCandidate);
    return cwdCandidate;
  }
  if (
    gitRootCandidate &&
    isPathWithinBase(scopeRoot, gitRootCandidate) &&
    (await pathExistsAsync(gitRootCandidate))
  ) {
    await assertExistingPathWithinBaseAsync(scopeRoot, gitRootCandidate);
    return gitRootCandidate;
  }
  if (gitRootCandidate && isPathWithinBase(scopeRoot, gitRootCandidate)) {
    return gitRootCandidate;
  }
  if (cwdCandidate) {
    return cwdCandidate;
  }
  throw new Error("Path must remain inside the workspace.");
}

async function assertExistingPathWithinBaseAsync(basePath: string, targetPath: string): Promise<void> {
  const [realBase, realTarget] = await Promise.all([
    fs.realpath(basePath),
    fs.realpath(targetPath),
  ]);
  if (!isPathWithinBase(realBase, realTarget)) {
    throw new Error("Path must remain inside the workspace.");
  }
}

function tryResolveWithinBase(basePath: string, targetPath: string): string | null {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);
  if (!isPathWithinBase(resolvedBase, resolvedTarget)) {
    return null;
  }
  return resolvedTarget;
}

async function pathExistsAsync(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  let nonPrintableCount = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintableCount += 1;
    }
  }
  return nonPrintableCount / buffer.length > 0.1;
}

function readWorkspaceNodes(cwd: string) {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 200)
      .map((entry) => ({
        path: path.join(cwd, entry.name),
        name: entry.name,
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }));
  } catch {
    return [];
  }
}

function normalizeWorkspaceSearchPath(relativePath: string): string {
  return relativePath.startsWith("./") ? relativePath.slice(2) : relativePath;
}
