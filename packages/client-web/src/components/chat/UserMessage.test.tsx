import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldPreCollapseUserMessage, UserMessage } from "./UserMessage";

test("renders structured image attachments before user text without the legacy image count pill", () => {
  const html = renderToStaticMarkup(
    createElement(UserMessage, {
      content: "What is shown here?",
      imageCount: 1,
      attachments: [
        {
          id: "99a9e525-2d58-41f6-afd1-976a04499d98",
          kind: "image",
          name: "chart.png",
          mediaType: "image/png",
          size: 1234,
        },
      ],
    }),
  );

  assert.match(html, /aria-label="Message attachments"/);
  assert.match(html, /aria-label="Open attached image chart\.png"/);
  assert.match(html, /title="chart\.png"/);
  assert.doesNotMatch(html, /Image x1/);
  assert.ok(html.indexOf("Message attachments") < html.indexOf("What is shown here?"));
});

test("keeps short user messages fully visible without an expansion control", () => {
  const html = renderToStaticMarkup(
    createElement(UserMessage, {
      content: "A short question",
    }),
  );

  assert.match(html, /A short question/);
  assert.doesNotMatch(html, /Show more/);
});

test("collapses large user messages without truncating their source text", () => {
  const content = `Start\n${"long input ".repeat(140)}\nEnd marker`;
  const html = renderToStaticMarkup(
    createElement(UserMessage, {
      content,
    }),
  );

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Show more/);
  assert.match(html, /End marker/);
});

test("pre-collapses messages that exceed explicit line or character limits", () => {
  assert.equal(shouldPreCollapseUserMessage("short"), false);
  assert.equal(shouldPreCollapseUserMessage("x".repeat(1_201)), true);
  assert.equal(
    shouldPreCollapseUserMessage(Array.from({ length: 17 }, (_, index) => `line ${index}`).join("\n")),
    true,
  );
});
