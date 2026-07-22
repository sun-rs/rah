import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureHighlighterLanguage,
  extractHighlightedCodeHtml,
  extractHighlightedLines,
  getHighlighter,
  highlight,
  normalizeShikiLanguage,
} from "./shiki";
import {
  CODEX_DARK_TOKEN_COLORS,
  CODEX_LIGHT_TOKEN_COLORS,
  codexShikiThemeForColorScheme,
} from "./codex-shiki-themes";

describe("shiki line extraction", () => {
  test("preserves nested token spans on a python import line", () => {
    const html = [
      '<pre class="shiki"><code>',
      '<span class="line"><span style="color:#0000FF">import</span><span style="color:#000000"> pathlib</span></span>',
      '<span class="line"><span style="color:#0000FF">from</span><span style="color:#000000"> os </span><span style="color:#0000FF">import</span><span style="color:#000000"> path</span></span>',
      "</code></pre>",
    ].join("");

    assert.deepEqual(extractHighlightedLines(html), [
      '<span style="color:#0000FF">import</span><span style="color:#000000"> pathlib</span>',
      '<span style="color:#0000FF">from</span><span style="color:#000000"> os </span><span style="color:#0000FF">import</span><span style="color:#000000"> path</span>',
    ]);
  });

  test("does not confuse token spans with line spans", () => {
    const html = [
      '<pre><code>',
      '<span class="line"><span style="color:#000000">{</span></span>',
      '<span class="line"><span style="color:#0451A5">"name"</span><span style="color:#000000">: </span><span style="color:#A31515">"rah"</span></span>',
      "</code></pre>",
    ].join("");

    assert.deepEqual(extractHighlightedLines(html), [
      '<span style="color:#000000">{</span>',
      '<span style="color:#0451A5">"name"</span><span style="color:#000000">: </span><span style="color:#A31515">"rah"</span>',
    ]);
  });

  test("preserves leading whitespace inside highlighted lines", () => {
    const html = [
      '<pre><code>',
      '<span class="line">    <span style="color:#0000FF">return</span><span style="color:#000000"> value</span></span>',
      "</code></pre>",
    ].join("");

    assert.deepEqual(extractHighlightedLines(html), [
      '    <span style="color:#0000FF">return</span><span style="color:#000000"> value</span>',
    ]);
  });

  test("normalizes common fenced-code aliases", () => {
    assert.equal(normalizeShikiLanguage("rs"), "rust");
    assert.equal(normalizeShikiLanguage("JS"), "javascript");
    assert.equal(normalizeShikiLanguage("shell"), "bash");
    assert.equal(normalizeShikiLanguage("unknown-language"), null);
  });

  test("extracts the highlighted code payload without Shiki's nested pre element", () => {
    assert.equal(
      extractHighlightedCodeHtml(
        '<pre class="shiki" style="background:#fff"><code><span class="line"><span style="color:#AF00DB">struct</span> Demo</span></code></pre>',
      ),
      '<span class="line"><span style="color:#AF00DB">struct</span> Demo</span>',
    );
  });

  test("selects the Codex theme for the active app color scheme", () => {
    assert.equal(codexShikiThemeForColorScheme("light"), "codex-light");
    assert.equal(codexShikiThemeForColorScheme("dark"), "codex-dark");
  });

  test("uses the Codex semantic palette for Rust in both themes", async () => {
    await getHighlighter();
    assert.equal(await ensureHighlighterLanguage("rust"), true);

    const source = 'pub struct Demo { value: f64, label: "rah" } // note';
    const light = highlight(source, "rust", "codex-light");
    const dark = highlight(source, "rust", "codex-dark");

    for (const color of [
      CODEX_LIGHT_TOKEN_COLORS.keyword,
      CODEX_LIGHT_TOKEN_COLORS.type,
      CODEX_LIGHT_TOKEN_COLORS.variable,
      CODEX_LIGHT_TOKEN_COLORS.string,
      CODEX_LIGHT_TOKEN_COLORS.comment,
    ]) {
      assert.match(light, new RegExp(color, "i"));
    }
    for (const color of [
      CODEX_DARK_TOKEN_COLORS.keyword,
      CODEX_DARK_TOKEN_COLORS.type,
      CODEX_DARK_TOKEN_COLORS.variable,
      CODEX_DARK_TOKEN_COLORS.string,
      CODEX_DARK_TOKEN_COLORS.comment,
    ]) {
      assert.match(dark, new RegExp(color, "i"));
    }
  });
});
