import { type CSSProperties } from "react";
import {
  CodexFileIconGlyph,
  type CodexFileIconName,
} from "./codex-file-icon-assets";

export type FileResourceKind = "code" | "document" | "image" | "spreadsheet";
export type FileResourceIconTone = "inherit" | "semantic";

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);
const SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx"]);
const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cjs",
  "cpp",
  "css",
  "cts",
  "go",
  "htm",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "jsonc",
  "jsonl",
  "kt",
  "mjs",
  "mts",
  "py",
  "pyi",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "yaml",
  "yml",
]);

const CODEX_FILE_ICON_COLOR: Readonly<
  Record<CodexFileIconName, `var(--file-icon-${string})`>
> = {
  css: "var(--file-icon-indigo)",
  database: "var(--file-icon-purple)",
  default: "var(--file-icon-gray)",
  html: "var(--file-icon-orange)",
  image: "var(--file-icon-pink)",
  javascript: "var(--file-icon-yellow)",
  json: "var(--file-icon-orange)",
  markdown: "var(--file-icon-green)",
  python: "var(--file-icon-blue)",
  react: "var(--file-icon-cyan)",
  rust: "var(--file-icon-orange)",
  svg: "var(--file-icon-orange)",
  table: "var(--file-icon-teal)",
  text: "var(--file-icon-gray)",
  typescript: "var(--file-icon-blue)",
  vite: "var(--file-icon-purple)",
  yml: "var(--file-icon-red)",
};

export function fileResourceExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (!name.includes(".")) {
    return "";
  }
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function fileResourceKind(path: string): FileResourceKind {
  const extension = fileResourceExtension(path);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return "spreadsheet";
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return "code";
  }
  return "document";
}

export function fileResourceIconName(path: string): CodexFileIconName {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? path.toLowerCase();
  const extension = fileResourceExtension(path);

  if (/^vite\.config\.(?:[cm]?[jt]s)$/.test(name)) {
    return "vite";
  }

  switch (extension) {
    case "css":
    case "sass":
    case "scss":
      return "css";
    case "db":
    case "sql":
    case "sqlite":
    case "sqlite3":
      return "database";
    case "htm":
    case "html":
      return "html";
    case "avif":
    case "bmp":
    case "gif":
    case "ico":
    case "jpeg":
    case "jpg":
    case "png":
    case "webp":
      return "image";
    case "cjs":
    case "js":
    case "mjs":
      return "javascript";
    case "json":
    case "jsonc":
    case "jsonl":
      return "json";
    case "markdown":
    case "md":
    case "mdx":
      return "markdown";
    case "py":
    case "pyi":
      return "python";
    case "jsx":
    case "tsx":
      return "react";
    case "rs":
      return "rust";
    case "svg":
      return "svg";
    case "csv":
    case "tsv":
    case "xls":
    case "xlsx":
      return "table";
    case "log":
    case "txt":
      return "text";
    case "cts":
    case "mts":
    case "ts":
      return "typescript";
    case "yaml":
    case "yml":
      return "yml";
    default:
      return "default";
  }
}

export function FileResourceIcon(props: {
  path: string;
  size?: number;
  className?: string;
  tone?: FileResourceIconTone;
}) {
  const extension = fileResourceExtension(props.path);
  const iconName = fileResourceIconName(props.path);
  const size = props.size ?? 16;
  const tone = props.tone ?? "semantic";
  const style = {
    "--file-resource-icon-size": `${size}px`,
    ...(tone === "semantic"
      ? { color: CODEX_FILE_ICON_COLOR[iconName] }
      : {}),
  } as CSSProperties;

  return (
    <span
      aria-hidden="true"
      className={`file-resource-icon ${props.className ?? ""}`}
      data-file-resource-kind={fileResourceKind(props.path)}
      data-file-extension={extension}
      data-file-icon-name={iconName}
      data-file-icon-tone={tone}
      style={style}
    >
      <CodexFileIconGlyph
        name={iconName}
        className="file-resource-icon-glyph"
      />
    </span>
  );
}
