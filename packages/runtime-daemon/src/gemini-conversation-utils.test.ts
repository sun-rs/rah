import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractGeminiUserDisplayText,
  extractTextFromContent,
  loadGeminiConversationRecord,
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

  test("loads jsonl duplicate message ids as in-place updates", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-history-"));
    const filePath = path.join(dir, "session.jsonl");
    try {
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            sessionId: "gemini-1",
            projectHash: "hash",
            startTime: "2026-01-01T00:00:00.000Z",
            lastUpdated: "2026-01-01T00:00:00.000Z",
          }),
          JSON.stringify({
            id: "assistant-1",
            timestamp: "2026-01-01T00:00:01.000Z",
            type: "gemini",
            content: "",
          }),
          JSON.stringify({
            id: "assistant-1",
            timestamp: "2026-01-01T00:00:01.000Z",
            type: "gemini",
            content: "",
            toolCalls: [
              {
                id: "update_topic_1",
                name: "update_topic",
                status: "success",
                result: [{ functionResponse: { response: { output: "done" } } }],
              },
            ],
          }),
        ].join("\n"),
      );

      const record = loadGeminiConversationRecord(filePath);
      assert.equal(record?.messages.length, 1);
      assert.equal(record?.messages[0]?.toolCalls?.[0]?.id, "update_topic_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("materializes Gemini tool result errors as failed calls", () => {
    const events = materializeGeminiConversationEvents({
      sessionId: "replay-1",
      conversation: {
        sessionId: "gemini-1",
        projectHash: "hash",
        startTime: "2026-01-01T00:00:00.000Z",
        lastUpdated: "2026-01-01T00:00:01.000Z",
        messages: [
          {
            id: "assistant-1",
            timestamp: "2026-01-01T00:00:00.000Z",
            type: "gemini",
            content: "",
            toolCalls: [
              {
                id: "replace-1",
                name: "replace",
                status: "success",
                result: [
                  {
                    functionResponse: {
                      response: {
                        error: "[Operation Cancelled] Reason: User denied execution.",
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    assert.equal(events.some((event) => event.type === "tool.call.failed"), true);
    assert.equal(events.some((event) => event.type === "tool.call.completed"), false);
  });
});
