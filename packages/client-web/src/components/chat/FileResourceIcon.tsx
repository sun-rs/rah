import React from "react";
import { FileCode2, FileImage, FileSpreadsheet, FileText } from "lucide-react";

export type FileResourceKind = "code" | "document" | "image" | "spreadsheet";

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx"]);
const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "go",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "kt",
  "mjs",
  "py",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "yaml",
  "yml",
]);

export function fileResourceKind(path: string): FileResourceKind {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
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

export function FileResourceIcon(props: {
  path: string;
  size?: number;
  className?: string;
}) {
  const common = {
    "aria-hidden": true,
    className: props.className,
    size: props.size ?? 14,
  } as const;
  switch (fileResourceKind(props.path)) {
    case "image":
      return <FileImage {...common} data-file-resource-kind="image" />;
    case "spreadsheet":
      return <FileSpreadsheet {...common} data-file-resource-kind="spreadsheet" />;
    case "code":
      return <FileCode2 {...common} data-file-resource-kind="code" />;
    case "document":
      return <FileText {...common} data-file-resource-kind="document" />;
  }
}
