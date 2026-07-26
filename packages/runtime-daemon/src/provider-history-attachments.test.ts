import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  cacheProviderHistoryImageDataUrl,
  providerHistoryAttachmentReference,
  resolveProviderHistoryAttachment,
} from "./provider-history-attachments";

test("provider history data URLs stay lazy and share one bounded materialization", async () => {
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 0x2a),
  ]);
  const attachment = cacheProviderHistoryImageDataUrl(
    `data:image/png;base64,${pngBytes.toString("base64")}`,
    "history.png",
  );
  assert.ok(attachment);
  assert.equal(providerHistoryAttachmentReference(attachment.id), null);

  const [first, second] = await Promise.all([
    resolveProviderHistoryAttachment(attachment.id),
    resolveProviderHistoryAttachment(attachment.id),
  ]);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.path, second.path);
  assert.deepEqual(await readFile(first.path), pngBytes);
  assert.equal(providerHistoryAttachmentReference(attachment.id)?.path, first.path);
});
