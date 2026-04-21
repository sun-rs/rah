import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;

export async function getHighlighter() {
  if (highlighter) return highlighter;
  highlighter = await createHighlighter({
    themes: ["github-dark", "github-light"],
    langs: ["typescript", "javascript", "json", "bash", "markdown", "python", "diff", "tsx"],
  });
  return highlighter;
}

export function highlight(code: string, lang: string, theme: "github-dark" | "github-light" = "github-dark") {
  if (!highlighter) return code;
  return highlighter.codeToHtml(code, { lang, theme });
}
