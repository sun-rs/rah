import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendImageDataUrlsToText,
  DATA_IMAGE_URL_PATTERN,
} from "./composer-image-attachments";

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";

test("appends pasted images to outgoing composer text without exposing invalid payloads", () => {
  assert.equal(
    appendImageDataUrlsToText("  explain this  ", [PNG_DATA_URL, "not-an-image"]),
    `explain this\n\n${PNG_DATA_URL}`,
  );
  assert.equal(appendImageDataUrlsToText("", [PNG_DATA_URL]), PNG_DATA_URL);
});

test("detects pasted image data URLs inside persisted user messages", () => {
  const text = `question\n\n${PNG_DATA_URL}`;
  const matches = text.match(DATA_IMAGE_URL_PATTERN) ?? [];
  assert.deepEqual(matches, [PNG_DATA_URL]);
});
