import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("Codex-compatible typography contract", () => {
  test("uses the native Electron foreground and variable system-font weight", () => {
    const cssSource = readSource("./index.css");

    assert.match(cssSource, /--foreground:\s*#1a1c1f;/);
    assert.match(cssSource, /--app-fg:\s*#1a1c1f;/);
    assert.match(cssSource, /--app-font-weight:\s*445;/);
    assert.match(cssSource, /body\s*\{[\s\S]*font-weight:\s*var\(--app-font-weight\);/);
  });

  test("keeps 14px chat copy on the desktop 22px line grid", () => {
    const tokenSource = readSource("./index.css");
    const proseSource = readSource("./styles.css");

    assert.match(tokenSource, /--chat-font-size:\s*14px;/);
    assert.match(
      tokenSource,
      /--chat-line-height:\s*calc\(var\(--chat-font-size\) \+ 8px\);/,
    );
    assert.match(
      proseSource,
      /\.chat-body-text,[\s\S]*\.prose-chat-final\s*\{[\s\S]*line-height:\s*var\(--chat-line-height\);/,
    );
  });

  test("uses the Codex Desktop light diff palette and separate gutter tones", () => {
    const tokenSource = readSource("./index.css");
    const previewSource = readSource("./inspector/InspectorPreviewDisplays.tsx");

    assert.match(tokenSource, /--diff-add-bg:\s*#e7f4e7;/);
    assert.match(tokenSource, /--diff-add-gutter-bg:\s*#edf7ed;/);
    assert.match(tokenSource, /--diff-add-gutter:\s*#00a241;/);
    assert.match(tokenSource, /--diff-remove-bg:\s*#fce7e2;/);
    assert.match(tokenSource, /--diff-remove-gutter-bg:\s*#fdece9;/);
    assert.match(tokenSource, /--diff-remove-gutter:\s*#ba2722;/);
    assert.match(tokenSource, /--diff-header-bg:\s*#f4f4f4;/);
    assert.match(tokenSource, /--diff-border:\s*#e8e8e8;/);
    assert.match(previewSource, /bg-\[var\(--diff-add-gutter-bg\)\]/);
    assert.match(previewSource, /bg-\[var\(--diff-remove-gutter-bg\)\]/);
  });
});
