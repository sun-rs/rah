import { useEffect, useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { codexShikiThemeForColorScheme } from "../lib/codex-shiki-themes";
import { ensureHighlighterLanguage, getHighlighter, highlightLines } from "../lib/shiki";

export function useHighlightedLineHtml(code: string | null, language: string | null) {
  const { colorScheme } = useTheme();
  const [htmlByLine, setHtmlByLine] = useState<string[]>([]);

  useEffect(() => {
    if (!language || code === null) {
      setHtmlByLine([]);
      return;
    }
    let cancelled = false;
    void getHighlighter()
      .then(async () => {
        if (cancelled) return;
        const loaded = await ensureHighlighterLanguage(language);
        if (cancelled) return;
        if (!loaded) {
          setHtmlByLine([]);
          return;
        }
        const theme = codexShikiThemeForColorScheme(colorScheme);
        const next = highlightLines(code, language, theme);
        setHtmlByLine(next);
      })
      .catch(() => {
        if (!cancelled) {
          setHtmlByLine([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, colorScheme, language]);

  return htmlByLine;
}
