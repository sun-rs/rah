import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { SessionInputRequest } from "@rah/runtime-protocol";
import {
  resolveDeviceAttachment,
  saveDeviceAttachment,
} from "./device-attachments";
import {
  codexTurnInput,
  nativeTuiInputText,
  openCodePromptParts,
  parsePersistedUserMessageContent,
} from "./session-input-attachments";
import { cacheProviderHistoryImageParts } from "./provider-history-attachments";

const previousRahHome = process.env.RAH_HOME;
const rahHome = mkdtempSync(path.join(os.tmpdir(), "rah-session-input-attachments-"));

before(() => {
  process.env.RAH_HOME = rahHome;
});

after(() => {
  if (previousRahHome === undefined) {
    delete process.env.RAH_HOME;
  } else {
    process.env.RAH_HOME = previousRahHome;
  }
  rmSync(rahHome, { recursive: true, force: true });
});

async function requestWithAttachments(): Promise<SessionInputRequest> {
  const image = await saveDeviceAttachment({
    bytes: Buffer.from("png"),
    name: "photo.png",
    mediaType: "image/png",
  });
  const file = await saveDeviceAttachment({
    bytes: Buffer.from("hello"),
    name: "notes.txt",
    mediaType: "text/plain",
  });
  return {
    clientId: "client-1",
    text: "Inspect these attachments.",
    attachments: [image, file],
  };
}

test("Codex receives images natively and host paths only for non-image files", async () => {
  const input = codexTurnInput(await requestWithAttachments());

  assert.equal(input.length, 2);
  assert.equal(input[0]?.type, "text");
  assert.match(
    input[0]?.type === "text" ? input[0].text : "",
    /Inspect these attachments\.[\s\S]*Attached files[\s\S]*notes\.txt/,
  );
  assert.doesNotMatch(
    input[0]?.type === "text" ? input[0].text : "",
    /photo\.png/,
  );
  assert.equal(input[1]?.type, "localImage");
  assert.match(input[1]?.type === "localImage" ? input[1].path : "", /photo\.png$/);
});

test("OpenCode receives native file parts without embedding file data in text", async () => {
  const parts = openCodePromptParts(await requestWithAttachments());

  assert.deepEqual(parts.map((part) => part.type), ["text", "file", "file"]);
  assert.equal(parts[0]?.type === "text" ? parts[0].text : "", "Inspect these attachments.");
  assert.equal(parts[1]?.type === "file" ? parts[1].mime : "", "image/png");
  assert.equal(parts[1]?.type === "file" ? parts[1].filename : "", "photo.png");
  assert.match(parts[1]?.type === "file" ? parts[1].url : "", /^file:\/\//);
  assert.equal(parts[2]?.type === "file" ? parts[2].filename : "", "notes.txt");
});

test("native TUI providers receive daemon-host paths and support attachment-only input", async () => {
  const request = await requestWithAttachments();
  const text = nativeTuiInputText({ ...request, text: "" });

  assert.match(text, /^Attached files \(available on the RAH host\):/);
  assert.match(text, /photo\.png/);
  assert.match(text, /notes\.txt/);
  assert.doesNotMatch(text, /data:image|base64/i);
});

test("persisted RAH image blocks restore a safe structured attachment", async () => {
  const image = await saveDeviceAttachment({
    bytes: Buffer.from("png"),
    name: "history.png",
    mediaType: "image/png",
  });
  const resolved = await resolveDeviceAttachment(image.id);
  const parsed = parsePersistedUserMessageContent(
    `Inspect this.\n<image name="[Image #1]" path="${resolved.path}">\n</image>`,
  );

  assert.equal(parsed.text, "Inspect this.");
  assert.equal(parsed.imageCount, 1);
  assert.deepEqual(parsed.attachments, [image]);
  assert.equal("path" in (parsed.attachments[0] ?? {}), false);
});

test("expired Codex remote image blocks retain a lazy generic image marker", () => {
  const parsed = parsePersistedUserMessageContent(
    "Question\n<image name=\"[Image #1]\" path=\"/tmp/codex-remote-attachments/thread/item/photo.png\">\n</image>",
  );

  assert.equal(parsed.text, "Question");
  assert.equal(parsed.imageCount, 1);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.kind, "image");
  assert.equal(parsed.attachments[0]?.name, "photo.png");
  assert.equal(parsed.attachments[0]?.size, 0);
  assert.deepEqual(parsed.mentionedFiles, []);
});

test("Codex file-mention envelopes expose only the real request and recover native image parts", async () => {
  const pixelPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz7c7wAAAABJRU5ErkJggg==";
  const parsed = parsePersistedUserMessageContent(`
# Files mentioned by the user:

## screenshot.png: /var/folders/example/T/screenshot.png

## My request for Codex:
Compare this screenshot.
<image name=[Image #1] path="/var/folders/example/T/screenshot.png">
</image>`);
  const attachments = cacheProviderHistoryImageParts(
    [
      { type: "input_text", text: "ignored" },
      { type: "input_image", image_url: `data:image/png;base64,${pixelPng}` },
    ],
    parsed.mentionedFiles.map((file) => file.name),
  );

  assert.equal(parsed.text, "Compare this screenshot.");
  assert.deepEqual(parsed.mentionedFiles, [
    { name: "screenshot.png", path: "/var/folders/example/T/screenshot.png" },
  ]);
  assert.equal(parsed.imageCount, 1);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.name, "screenshot.png");
  assert.equal(attachments[0]?.kind, "image");
  const resolved = await resolveDeviceAttachment(attachments[0]!.id);
  assert.equal(resolved.size, Buffer.from(pixelPng, "base64").byteLength);
});

test("untrusted image-like blocks remain plain user text", () => {
  const source = '<image name="[Image #1]" path="/etc/passwd">\n</image>';
  const parsed = parsePersistedUserMessageContent(source);

  assert.equal(parsed.text, source);
  assert.equal(parsed.imageCount, 0);
  assert.deepEqual(parsed.attachments, []);
  assert.deepEqual(parsed.mentionedFiles, []);
});
