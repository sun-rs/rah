import React from "react";
import { Atom, FileCode2, FileImage, FileSpreadsheet, FileText } from "lucide-react";

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

type ExtensionBadge = {
  label: string;
  foreground: string;
  background: string;
};

const EXTENSION_BADGES: Readonly<Record<string, ExtensionBadge>> = {
  c: { label: "C", foreground: "#2563eb", background: "rgba(37, 99, 235, 0.12)" },
  cc: { label: "C+", foreground: "#2563eb", background: "rgba(37, 99, 235, 0.12)" },
  cpp: { label: "C+", foreground: "#2563eb", background: "rgba(37, 99, 235, 0.12)" },
  css: { label: "#", foreground: "#2563eb", background: "rgba(37, 99, 235, 0.12)" },
  go: { label: "Go", foreground: "#0891b2", background: "rgba(8, 145, 178, 0.12)" },
  html: { label: "<>" , foreground: "#ea580c", background: "rgba(234, 88, 12, 0.12)" },
  java: { label: "J", foreground: "#dc2626", background: "rgba(220, 38, 38, 0.11)" },
  js: { label: "JS", foreground: "#ca8a04", background: "rgba(234, 179, 8, 0.16)" },
  json: { label: "{}", foreground: "#a16207", background: "rgba(202, 138, 4, 0.13)" },
  mjs: { label: "JS", foreground: "#ca8a04", background: "rgba(234, 179, 8, 0.16)" },
  cjs: { label: "JS", foreground: "#ca8a04", background: "rgba(234, 179, 8, 0.16)" },
  md: { label: "M↓", foreground: "#16a34a", background: "transparent" },
  mdx: { label: "M↓", foreground: "#16a34a", background: "transparent" },
  py: { label: "Py", foreground: "#2563eb", background: "rgba(37, 99, 235, 0.12)" },
  rs: { label: "Rs", foreground: "#c2410c", background: "rgba(194, 65, 12, 0.12)" },
  sh: { label: "$", foreground: "#52525b", background: "rgba(113, 113, 122, 0.12)" },
  sql: { label: "DB", foreground: "#7c3aed", background: "rgba(124, 58, 237, 0.12)" },
  swift: { label: "S", foreground: "#ea580c", background: "rgba(234, 88, 12, 0.12)" },
  toml: { label: "T", foreground: "#7c3aed", background: "rgba(124, 58, 237, 0.12)" },
  ts: { label: "TS", foreground: "#0284c7", background: "rgba(2, 132, 199, 0.13)" },
  yaml: { label: "Y", foreground: "#7c3aed", background: "rgba(124, 58, 237, 0.12)" },
  yml: { label: "Y", foreground: "#7c3aed", background: "rgba(124, 58, 237, 0.12)" },
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

export function FileResourceIcon(props: {
  path: string;
  size?: number;
  className?: string;
}) {
  const extension = fileResourceExtension(props.path);
  const size = props.size ?? 14;
  const common = {
    "aria-hidden": true,
    className: props.className,
    size,
  } as const;

  if (extension === "jsx" || extension === "tsx") {
    return (
      <Atom
        {...common}
        color="#0891b2"
        data-file-resource-kind="code"
        data-file-extension={extension}
      />
    );
  }

  const badge = EXTENSION_BADGES[extension];
  if (badge) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 select-none items-center justify-center rounded-[5px] font-sans font-semibold leading-none ${props.className ?? ""}`}
        data-file-resource-kind={fileResourceKind(props.path)}
        data-file-extension={extension}
        style={{
          width: Math.max(size, badge.label.length > 2 ? size + 5 : size + 2),
          minWidth: Math.max(size, badge.label.length > 2 ? size + 5 : size + 2),
          height: size,
          fontSize: Math.max(8, Math.round(size * 0.58)),
          color: badge.foreground,
          backgroundColor: badge.background,
        }}
      >
        {badge.label}
      </span>
    );
  }

  switch (fileResourceKind(props.path)) {
    case "image":
      return <FileImage {...common} data-file-resource-kind="image" data-file-extension={extension} />;
    case "spreadsheet":
      return <FileSpreadsheet {...common} data-file-resource-kind="spreadsheet" data-file-extension={extension} />;
    case "code":
      return <FileCode2 {...common} data-file-resource-kind="code" data-file-extension={extension} />;
    case "document":
      return <FileText {...common} data-file-resource-kind="document" data-file-extension={extension} />;
  }
}
