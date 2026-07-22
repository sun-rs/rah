import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_IMAGE_URL_PATTERN,
  imageFilesFromClipboardData,
} from "./composer-image-attachments";

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";

test("detects pasted image data URLs inside persisted user messages", () => {
  const text = `question\n\n${PNG_DATA_URL}`;
  const matches = text.match(DATA_IMAGE_URL_PATTERN) ?? [];
  assert.deepEqual(matches, [PNG_DATA_URL]);
});

function fakeFile(name: string, type: string): File {
  return { name, type } as File;
}

function fakeClipboardData(input: {
  items?: Array<{ kind: string; type: string; file: File | null }>;
  files?: File[];
}): DataTransfer {
  return {
    items: (input.items ?? []).map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file,
    })),
    files: input.files ?? [],
  } as unknown as DataTransfer;
}

test("extracts pasted image files from clipboard items and ignores non-images", () => {
  const image = fakeFile("chart.png", "image/png");
  const text = fakeFile("notes.txt", "text/plain");
  const data = fakeClipboardData({
    items: [
      { kind: "file", type: "text/plain", file: text },
      { kind: "string", type: "image/png", file: image },
      { kind: "file", type: "image/png", file: image },
    ],
  });

  assert.deepEqual(imageFilesFromClipboardData(data), [image]);
});

test("falls back to clipboard files when item access is unavailable", () => {
  const image = fakeFile("photo.jpeg", "image/jpeg");
  const text = fakeFile("notes.txt", "text/plain");

  assert.deepEqual(
    imageFilesFromClipboardData(fakeClipboardData({ files: [text, image] })),
    [image],
  );
  assert.deepEqual(imageFilesFromClipboardData(null), []);
});
