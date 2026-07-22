import type { LanguageRegistration } from "@shikijs/types";
import {
  CODEX_SHIKI_THEMES,
  type CodexShikiThemeName,
} from "./codex-shiki-themes";

type ShikiThemeName = CodexShikiThemeName;
type ShikiLanguageName =
  | "typescript"
  | "javascript"
  | "json"
  | "bash"
  | "markdown"
  | "python"
  | "diff"
  | "tsx"
  | "rust"
  | "toml"
  | "yaml"
  | "html"
  | "css"
  | "sql";

type MinimalHighlighter = {
  codeToHtml(code: string, options: { lang: string; theme: string }): string;
  loadLanguage(...langs: LanguageRegistration[]): Promise<void>;
};

let highlighter: MinimalHighlighter | null = null;
let highlighterPromise: Promise<MinimalHighlighter> | null = null;
const loadedLanguages = new Set<string>();
const languageLoadPromises = new Map<string, Promise<boolean>>();

const LANGUAGE_LOADERS: Record<ShikiLanguageName, () => Promise<{ default: LanguageRegistration[] }>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  bash: () => import("@shikijs/langs/bash"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  diff: () => import("@shikijs/langs/diff"),
  tsx: () => import("@shikijs/langs/tsx"),
  rust: () => import("@shikijs/langs/rust"),
  toml: () => import("@shikijs/langs/toml"),
  yaml: () => import("@shikijs/langs/yaml"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  sql: () => import("@shikijs/langs/sql"),
};

export async function getHighlighter() {
  if (highlighter) return highlighter;
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ])
      .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
        createHighlighterCore({
          engine: createJavaScriptRegexEngine(),
          themes: [...CODEX_SHIKI_THEMES],
          langs: [],
        }),
      )
      .then((instance) => {
        highlighter = instance;
        return instance;
      })
      .catch((error) => {
        highlighterPromise = null;
        throw error;
      });
  }
  return highlighterPromise;
}

const LANGUAGE_ALIASES: Readonly<Record<string, ShikiLanguageName>> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  python: "python",
  diff: "diff",
  patch: "diff",
  tsx: "tsx",
  rs: "rust",
  rust: "rust",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  htm: "html",
  css: "css",
  sql: "sql",
};

export function normalizeShikiLanguage(language: string | null | undefined): ShikiLanguageName | null {
  if (!language) return null;
  return LANGUAGE_ALIASES[language.trim().toLocaleLowerCase()] ?? null;
}

export async function ensureHighlighterLanguage(language: string): Promise<boolean> {
  const normalized = normalizeShikiLanguage(language);
  if (!normalized) {
    return false;
  }
  if (loadedLanguages.has(normalized)) {
    return true;
  }
  const existing = languageLoadPromises.get(normalized);
  if (existing) return existing;
  const loadPromise = getHighlighter()
    .then(async (instance) => {
      const languageModule = await LANGUAGE_LOADERS[normalized]();
      await instance.loadLanguage(...languageModule.default);
      loadedLanguages.add(normalized);
      return true;
    })
    .finally(() => languageLoadPromises.delete(normalized));
  languageLoadPromises.set(normalized, loadPromise);
  return loadPromise;
}

function hasLineClass(spanTag: string): boolean {
  const classMatch = /\sclass=(["'])(.*?)\1/.exec(spanTag);
  if (!classMatch) {
    return false;
  }
  return classMatch[2]!.split(/\s+/).includes("line");
}

export function extractHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const spanTagPattern = /<\/?span\b[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = spanTagPattern.exec(html))) {
    const tag = match[0];
    if (tag.startsWith("</") || !hasLineClass(tag)) {
      continue;
    }

    const contentStart = spanTagPattern.lastIndex;
    let depth = 1;
    let nestedMatch: RegExpExecArray | null;
    while ((nestedMatch = spanTagPattern.exec(html))) {
      const nestedTag = nestedMatch[0];
      depth += nestedTag.startsWith("</") ? -1 : 1;
      if (depth === 0) {
        lines.push(html.slice(contentStart, nestedMatch.index) || " ");
        break;
      }
    }
  }

  return lines;
}

export function highlight(code: string, lang: string, theme: ShikiThemeName = "codex-light") {
  const normalized = normalizeShikiLanguage(lang);
  if (!highlighter || !normalized || !loadedLanguages.has(normalized)) return code;
  return highlighter.codeToHtml(code, { lang: normalized, theme });
}

export function highlightLines(
  code: string,
  lang: string,
  theme: ShikiThemeName = "codex-light",
): string[] {
  const normalized = normalizeShikiLanguage(lang);
  if (!highlighter || !normalized || !loadedLanguages.has(normalized)) {
    return code.split("\n");
  }
  return extractHighlightedLines(highlighter.codeToHtml(code || " ", { lang: normalized, theme }));
}

export function extractHighlightedCodeHtml(html: string): string | null {
  const match = /<code\b[^>]*>([\s\S]*?)<\/code>/.exec(html);
  return match?.[1] ?? null;
}
