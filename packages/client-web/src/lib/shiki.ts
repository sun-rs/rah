import type { LanguageRegistration, ThemeRegistration } from "@shikijs/types";

type ShikiThemeName = "dark-plus" | "light-plus";
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
const loadedLanguages = new Set<string>();

const THEME_LOADERS: Record<ShikiThemeName, () => Promise<{ default: ThemeRegistration }>> = {
  "dark-plus": () => import("@shikijs/themes/dark-plus"),
  "light-plus": () => import("@shikijs/themes/light-plus"),
};

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
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, themeModules] =
    await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      Promise.all(Object.values(THEME_LOADERS).map((load) => load())),
    ]);
  highlighter = await createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: themeModules.map((module) => module.default),
    langs: [],
  });
  return highlighter;
}

function isKnownLanguage(language: string): language is ShikiLanguageName {
  return language in LANGUAGE_LOADERS;
}

export async function ensureHighlighterLanguage(language: string): Promise<boolean> {
  if (!isKnownLanguage(language)) {
    return false;
  }
  if (loadedLanguages.has(language)) {
    return true;
  }
  const instance = await getHighlighter();
  const languageModule = await LANGUAGE_LOADERS[language]();
  await instance.loadLanguage(...languageModule.default);
  loadedLanguages.add(language);
  return true;
}

function extractHighlightedLines(html: string): string[] {
  const matches = Array.from(
    html.matchAll(/<span class="line">([\s\S]*?)<\/span>/g),
    (match) => match[1] || " ",
  );
  return matches;
}

export function highlight(code: string, lang: string, theme: ShikiThemeName = "dark-plus") {
  if (!highlighter || !loadedLanguages.has(lang)) return code;
  return highlighter.codeToHtml(code, { lang, theme });
}

export function highlightLines(
  code: string,
  lang: string,
  theme: ShikiThemeName = "dark-plus",
): string[] {
  if (!highlighter || !loadedLanguages.has(lang)) {
    return code.split("\n");
  }
  return extractHighlightedLines(highlighter.codeToHtml(code || " ", { lang, theme }));
}
