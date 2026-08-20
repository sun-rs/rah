import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMessage } from "./AssistantMessage";
import { InteractiveVisualArtifactError } from "./InteractiveVisualArtifact";

const visualArtifact = {
  id: "equity-curve.html",
  format: "interactive_html" as const,
  mimeType: "text/html" as const,
  label: "Equity curve",
};

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
          artifact: visualArtifact,
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

test("passes the local file opener through to interactive visuals", () => {
  const html = renderToStaticMarkup(
    createElement(AssistantMessage, {
      content: "Curve",
      sessionId: "runtime-session-1",
      variant: "final",
      onOpenLocalFile: () => undefined,
      contentParts: [
        {
          kind: "visual",
          artifact: visualArtifact,
        },
      ],
    }),
  );

  assert.match(html, /interactive-visual-loading/);
});

test("interactive visual failure exposes the verified HTML source", () => {
  const sourcePath =
    "/workspace/.codex/visualizations/2026/08/13/session/equity-curve.html";
  const html = renderToStaticMarkup(
    createElement(InteractiveVisualArtifactError, {
      artifact: visualArtifact,
      error: "Failed to load visual",
      sourcePath,
      onOpenLocalFile: () => undefined,
    }),
  );

  assert.match(html, /Interactive visual could not be displayed\./);
  assert.match(html, /<button/);
  assert.match(html, /Equity curve/);
  assert.match(html, new RegExp(sourcePath.replaceAll("/", "\\/")));
  assert.doesNotMatch(html, /This visual is no longer available/);
});

test("interactive visual failure distinguishes a missing HTML source", () => {
  const html = renderToStaticMarkup(
    createElement(InteractiveVisualArtifactError, {
      artifact: visualArtifact,
      error: "Unknown visual",
      sourcePath: null,
    }),
  );

  assert.match(html, /HTML source not found: equity-curve\.html/);
  assert.doesNotMatch(html, /<button/);
});
