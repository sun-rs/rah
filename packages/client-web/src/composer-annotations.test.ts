import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendComposerAnnotation,
  createComposerAnnotation,
  normalizeSelectedConversationText,
} from "./composer-annotations";

test("normalizes selected response text without flattening meaningful line breaks", () => {
  assert.equal(
    normalizeSelectedConversationText("  first\u00a0line  \nsecond\n\n\n\nthird  "),
    "first line\nsecond\n\n\nthird",
  );
});

test("creates provider-safe annotation metadata and appends it once", () => {
  const annotation = createComposerAnnotation({
    text: " selected text ",
    source: {
      sessionId: "session-1",
      entryKey: "assistant-1",
      role: "assistant",
    },
  });
  assert.ok(annotation);
  assert.equal(annotation.text, "selected text");
  assert.deepEqual(annotation.source, {
    sessionId: "session-1",
    entryKey: "assistant-1",
    role: "assistant",
  });
  assert.equal(appendComposerAnnotation([], annotation).length, 1);
  assert.equal(appendComposerAnnotation([annotation], annotation).length, 1);
});
