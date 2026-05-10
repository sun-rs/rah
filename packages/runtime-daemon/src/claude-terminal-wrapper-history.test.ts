import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  extractAssistantMessageText,
  extractUserMessageText,
} from "./claude-terminal-wrapper-history";

describe("claude terminal wrapper history helpers", () => {
  test("filters local command transcript noise from user content", () => {
    const text = extractUserMessageText([
      {
        type: "text",
        text: "<local-command-caveat>Caveat: local command.</local-command-caveat>",
      },
      {
        type: "text",
        text: "<command-name>/model</command-name>",
      },
      {
        type: "text",
        text: "<command-message>model</command-message>",
      },
      {
        type: "text",
        text: "<command-args></command-args>",
      },
    ]);

    assert.equal(text, null);
  });

  test("filters local command transcript noise from assistant content", () => {
    const text = extractAssistantMessageText([
      {
        type: "text",
        text: "<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>",
      },
      {
        type: "text",
        text: "No response requested.",
      },
    ]);

    assert.equal(text, null);
  });

  test("preserves normal user and assistant text", () => {
    assert.equal(
      extractUserMessageText([{ type: "text", text: "hello" }]),
      "hello",
    );
    assert.equal(
      extractAssistantMessageText([{ type: "text", text: "world" }]),
      "world",
    );
  });

  test("strips Claude turn_aborted context fragments from transcript text", () => {
    assert.equal(
      extractUserMessageText([
        {
          type: "text",
          text: [
            "休眠五秒",
            "<turn_aborted>",
            "The user interrupted the previous turn on purpose.",
            "</turn_aborted>",
          ].join("\n"),
        },
      ]),
      "休眠五秒",
    );
    assert.equal(
      extractUserMessageText([
        {
          type: "text",
          text: "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
        },
      ]),
      null,
    );
  });

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
      extractAssistantMessageText([{ type: "text", text: `\n${markdown}\n` }]),
      markdown,
    );
  });
});
