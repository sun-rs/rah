import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMessage } from "./AssistantMessage";

test("preserves provider-native text and visual ordering in assistant replies", () => {
  const html = renderToStaticMarkup(
    createElement(AssistantMessage, {
      content: "Before the curve.\n\nAfter the curve.",
      sessionId: "runtime-session-1",
      variant: "final",
      contentParts: [
        { kind: "text", text: "Before the curve." },
        {
          kind: "visual",
          artifact: {
            id: "equity-curve.html",
            format: "interactive_html",
            mimeType: "text/html",
            label: "Equity curve",
          },
        },
        { kind: "text", text: "After the curve." },
      ],
    }),
  );

  const beforeIndex = html.indexOf("Before the curve.");
  const visualIndex = html.indexOf("interactive-visual-loading");
  const afterIndex = html.indexOf("After the curve.");
  assert.ok(beforeIndex >= 0);
  assert.ok(visualIndex > beforeIndex);
  assert.ok(afterIndex > visualIndex);
  assert.doesNotMatch(html, /codex-inline-vis/);
});
