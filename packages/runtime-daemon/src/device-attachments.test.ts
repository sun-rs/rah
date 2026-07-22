import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  MAX_DEVICE_ATTACHMENT_BYTES,
  resolveDeviceAttachment,
  saveDeviceAttachment,
} from "./device-attachments";

const previousRahHome = process.env.RAH_HOME;
const rahHome = mkdtempSync(path.join(os.tmpdir(), "rah-device-attachments-"));

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

test("stores attachment bytes under the daemon home and resolves an opaque id", async () => {
  const attachment = await saveDeviceAttachment({
    bytes: Buffer.from("image-bytes"),
    name: "../camera/photo.png",
    mediaType: "image/png; charset=binary",
  });

  assert.equal(attachment.kind, "image");
  assert.equal(attachment.name, "photo.png");
  assert.equal(attachment.mediaType, "image/png");
  assert.equal(attachment.size, 11);

  const resolved = resolveDeviceAttachment(attachment.id);
  assert.equal(readFileSync(resolved.path, "utf8"), "image-bytes");
  assert.equal(path.dirname(path.dirname(resolved.path)), path.join(rahHome, "attachments"));
  assert.equal(resolved.name, "photo.png");
});

test("rejects missing, malformed, oversized, and tampered attachments", async () => {
  assert.throws(
    () => resolveDeviceAttachment("../../outside"),
    /Unknown attachment/,
  );
  await assert.rejects(
    saveDeviceAttachment({ bytes: Buffer.alloc(0) }),
    /attachment body is empty/,
  );
  await assert.rejects(
    saveDeviceAttachment({ bytes: Buffer.alloc(MAX_DEVICE_ATTACHMENT_BYTES + 1) }),
    /too large/,
  );

  const attachment = await saveDeviceAttachment({
    bytes: Buffer.from("original"),
    name: "notes.txt",
    mediaType: "text/plain",
  });
  const resolved = resolveDeviceAttachment(attachment.id);
  writeFileSync(resolved.path, "changed", "utf8");
  chmodSync(resolved.path, 0o600);
  assert.throws(() => resolveDeviceAttachment(attachment.id), /Unknown attachment/);
});
