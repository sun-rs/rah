import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;

export async function getHighlighter() {
  if (highlighter) return highlighter;
  highlighter = await createHighlighter({
    themes: ["dark-plus", "light-plus"],
    langs: [
      "typescript",
      "javascript",
      "json",
      "bash",
      "markdown",
      "python",
      "diff",
      "tsx",
      "rust",
      "toml",
      "yaml",
      "html",
      "css",
      "sql",
    ],
  });
  return highlighter;
}

function extractHighlightedLines(html: string): string[] {
  const matches = Array.from(
    html.matchAll(/<span class="line">([\s\S]*?)<\/span>/g),
    (match) => match[1] || " ",
  );
  return matches;
}

export function highlight(code: string, lang: string, theme: "dark-plus" | "light-plus" = "dark-plus") {
  if (!highlighter) return code;
  return highlighter.codeToHtml(code, { lang, theme });
}

export function highlightLines(
  code: string,
  lang: string,
  theme: "dark-plus" | "light-plus" = "dark-plus",
): string[] {
  if (!highlighter) {
    return code.split("\n");
  }
  return extractHighlightedLines(highlighter.codeToHtml(code || " ", { lang, theme }));
}
