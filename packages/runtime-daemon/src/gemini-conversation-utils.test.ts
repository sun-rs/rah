import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  extractGeminiUserDisplayText,
  extractTextFromContent,
  materializeGeminiConversationEvents,
} from "./gemini-conversation-utils";

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

  test("uses Gemini displayContent for user-visible prompt text", () => {
    assert.equal(
      extractGeminiUserDisplayText({
        content: [
          { text: "@design/doc.md explain this" },
          { text: "\n--- Content from referenced files ---" },
          { text: "\n# Huge expanded document\n" },
        ],
        displayContent: [{ text: "@design/doc.md explain this" }],
      }),
      "@design/doc.md explain this",
    );
  });

  test("materializes Gemini user history from displayContent instead of expanded prompt", () => {
    const events = materializeGeminiConversationEvents({
      sessionId: "replay-1",
      conversation: {
        sessionId: "gemini-1",
        projectHash: "hash",
        startTime: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T00:00:01.000Z",
        messages: [
          {
            id: "user-1",
            timestamp: "2026-01-01T00:00:00.000Z",
            type: "user",
            content: [
              { text: "@design/doc.md explain this" },
              { text: "\n--- Content from referenced files ---" },
              { text: "\n# Huge expanded document\n" },
            ],
            displayContent: [{ text: "@design/doc.md explain this" }],
          },
        ],
      },
    });
    const userTexts = events.flatMap((event) => {
      if (
        event.type === "timeline.item.added" &&
        event.payload.item.kind === "user_message"
      ) {
        return [event.payload.item.text];
      }
      return [];
    });
    assert.deepEqual(userTexts, ["@design/doc.md explain this"]);
  });
});
