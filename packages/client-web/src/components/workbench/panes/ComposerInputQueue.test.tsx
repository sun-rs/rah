import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerInputQueue } from "./ComposerInputQueue";

test("renders queued follow-ups above the composer instead of as chat bubbles", () => {
  const html = renderToStaticMarkup(
    createElement(ComposerInputQueue, {
      items: [
        {
          clientMessageId: "message-1",
          text: "First follow-up",
          queuedAt: "2026-07-21T00:00:00.000Z",
          position: 1,
          state: "queued",
        },
        {
          clientMessageId: "message-2",
          text: "Second follow-up",
          queuedAt: "2026-07-21T00:00:01.000Z",
          position: 2,
          state: "queued",
        },
      ],
      canSteer: true,
      onUpdate: () => undefined,
      onDelete: () => undefined,
      onReorder: () => undefined,
      onSteer: () => undefined,
    }),
  );

  assert.match(html, /data-testid="composer-input-queue"/);
  assert.match(html, /First follow-up/);
  assert.match(html, /Second follow-up/);
  assert.equal(html.match(/>Guide</g)?.length, 2);
  assert.doesNotMatch(html, /Turn (?:on|off) queueing/);
  assert.doesNotMatch(html, /data-testid="chat-user-message"/);
});
