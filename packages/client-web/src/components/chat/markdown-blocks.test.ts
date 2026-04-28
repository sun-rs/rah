import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownBlocks } from "./markdown-blocks";

describe("splitMarkdownBlocks", () => {
  test("splits paragraphs while preserving fenced code block internals", () => {
    assert.deepEqual(
      splitMarkdownBlocks("First paragraph\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter"),
      ["First paragraph", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "After"],
    );
  });

  test("keeps list lines together for markdown parsing", () => {
    assert.deepEqual(
      splitMarkdownBlocks("Recent 规则也改了：\n- 纯打开 history\n- claim 后进入 recent"),
      ["Recent 规则也改了：\n- 纯打开 history\n- claim 后进入 recent"],
    );
  });

  test("keeps unterminated fences intact", () => {
    assert.deepEqual(
      splitMarkdownBlocks("Before\n\n```text\nunfinished\n\nstill code"),
      ["Before", "```text\nunfinished\n\nstill code"],
    );
  });
});
