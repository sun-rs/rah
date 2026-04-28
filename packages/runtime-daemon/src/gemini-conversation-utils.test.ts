import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractTextFromContent } from "./gemini-conversation-utils";

describe("Gemini conversation utils", () => {
  test("preserves markdown line breaks and indentation", () => {
    const markdown = [
      "会涉及抽象。",
      "",
      "- AgentAdapter",
      "  - nested item",
      "",
      "```text",
      "  Council",
      "```",
    ].join("\n");

    assert.equal(
      extractTextFromContent([{ text: `\n${markdown}\n` }]),
      markdown,
    );
  });
});
