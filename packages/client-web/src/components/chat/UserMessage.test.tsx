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

test("renders unavailable historical images as compact thumbnail placeholders", () => {
  const html = renderToStaticMarkup(
    createElement(UserMessage, {
      content: "The original image is unavailable.",
      imageCount: 2,
    }),
  );

  assert.match(html, /aria-label="Message attachments"/);
  assert.equal(
    (html.match(/aria-label="Unavailable image attachment"/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(html, /Images x2|Files mentioned by the user|&lt;image/);
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

test("renders an in-turn Guide as a compact hover row instead of a user bubble", () => {
  const html = renderToStaticMarkup(
    createElement(UserMessage, {
      content: "Use the first SimNow group",
      presentation: "guidance",
      entryKey: "guide-1",
    }),
  );

  assert.match(html, /data-testid="chat-guidance-message"/);
  assert.match(html, />Guide</);
  assert.match(html, /Use the first SimNow group/);
  assert.match(html, /aria-label="Copy Guide"/);
  assert.doesNotMatch(html, /data-testid="chat-user-message"/);
  assert.doesNotMatch(html, /rounded-2xl rounded-tr-md/);
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
  assert.match(html, /data-testid="user-message-collapse-fade"/);
  assert.match(html, /bottom-0 h-7/);
  assert.doesNotMatch(html, /bottom-0 h-12/);
  assert.doesNotMatch(html, /mt-0\.5 inline-flex h-5/);
  assert.doesNotMatch(html, /class="leading-none">\.\.\.</);
});

test("pre-collapses messages that exceed explicit line or character limits", () => {
  assert.equal(shouldPreCollapseUserMessage("short"), false);
  assert.equal(shouldPreCollapseUserMessage("x".repeat(1_201)), true);
  assert.equal(
    shouldPreCollapseUserMessage(Array.from({ length: 17 }, (_, index) => `line ${index}`).join("\n")),
    true,
  );
});
