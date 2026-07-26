import { createHash } from "node:crypto";
import { chmod, mkdtemp, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionInputAttachment } from "@rah/runtime-protocol";
import { runBackgroundCommand } from "./background-command";
import {
  HISTORY_WORKLOAD_PRIORITY,
  sharedHistoryWorkloadScheduler,
} from "./history-workload-governor";

const HISTORY_ATTACHMENT_ID_PREFIX = "history-image-";
const HISTORY_PATH_ATTACHMENT_ID_PREFIX = "history-path-";
const MAX_HISTORY_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_HISTORY_ATTACHMENT_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY_ATTACHMENT_CACHE_ENTRIES = 2_048;
const FINGERPRINT_SAMPLE_BYTES = 8 * 1024;
const VALIDATION_SAMPLE_CHARS = 2 * 1024;

type ProviderHistoryAttachment = SessionInputAttachment & {
  path?: string;
};

type ResolvedProviderHistoryAttachment = SessionInputAttachment & {
  path: string;
};

type CachedProviderHistoryAttachment = {
  attachment: ProviderHistoryAttachment;
  owned: boolean;
  cacheWeight: number;
  encodedBase64?: string;
  materializing?: Promise<string>;
};

const cachedAttachments = new Map<string, CachedProviderHistoryAttachment>();
let cachedBytes = 0;
let cacheRootPromise: Promise<string> | undefined;

const MATERIALIZE_IMAGE_SCRIPT = String.raw`
const fs = require("node:fs");
const [target, mediaType, expectedSizeText, maxEncodedText] = process.argv.slice(1);
const expectedSize = Number(expectedSizeText);
const maxEncoded = Number(maxEncodedText);
let encodedBytes = 0;
const chunks = [];
function fail(error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
function plausible(bytes, type) {
  switch (type) {
    case "image/png":
      return bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return /^(?:GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii"));
    case "image/webp":
      return bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP";
    case "image/svg+xml":
      return /^(?:<\?xml[\s\S]*?>\s*)?<svg[\s>]/i.test(
        bytes.subarray(0, Math.min(bytes.length, 1024)).toString("utf8").trimStart(),
      );
    case "image/heic":
    case "image/avif":
      return bytes.subarray(4, 12).toString("ascii").includes("ftyp");
    default:
      return false;
  }
}
process.stdin.on("data", (chunk) => {
  encodedBytes += chunk.length;
  if (encodedBytes > maxEncoded) {
    fail(new Error("encoded image exceeded its declared limit"));
    process.stdin.destroy();
    return;
  }
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  if (process.exitCode) return;
  try {
    const encoded = Buffer.concat(chunks, encodedBytes).toString("ascii");
    if (
      encoded.length !== encodedBytes ||
      encoded.length === 0 ||
      encoded.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
      throw new Error("invalid base64 image");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== expectedSize || !plausible(bytes, mediaType)) {
      throw new Error("decoded image failed validation");
    }
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    fail(error);
  }
});
`;

async function ensureCacheRoot(): Promise<string> {
  if (!cacheRootPromise) {
    cacheRootPromise = mkdtemp(join(tmpdir(), "rah-history-attachments-"))
      .then(async (root) => {
        await chmod(root, 0o700);
        return root;
      })
      .catch((error) => {
        cacheRootPromise = undefined;
        throw error;
      });
  }
  return await cacheRootPromise;
}

function normalizedMediaType(value: string): string | null {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType.startsWith("image/") ? mediaType : null;
}

function mediaTypeExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/heic":
      return ".heic";
    case "image/avif":
      return ".avif";
    default:
      return ".png";
  }
}

function mediaTypeFromPath(filePath: string): string | null {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".heic":
      return "image/heic";
    case ".avif":
      return "image/avif";
    default:
      return null;
  }
}

function safeAttachmentName(value: string | undefined, mediaType: string): string {
  const source = basename(value?.trim() || `Image${mediaTypeExtension(mediaType)}`);
  const normalized = source
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:]/g, "-")
    .trim();
  return (normalized || `Image${mediaTypeExtension(mediaType)}`).slice(0, 180);
}

function publicAttachment(
  attachment: ProviderHistoryAttachment,
): SessionInputAttachment {
  const { path: _path, ...publicValue } = attachment;
  return publicValue;
}

function touchEntry(
  id: string,
  entry: CachedProviderHistoryAttachment,
): void {
  cachedAttachments.delete(id);
  cachedAttachments.set(id, entry);
}

function discardEntry(id: string, entry: CachedProviderHistoryAttachment): void {
  cachedAttachments.delete(id);
  cachedBytes = Math.max(0, cachedBytes - entry.cacheWeight);
  if (!entry.owned || !entry.attachment.path) {
    return;
  }
  void unlink(entry.attachment.path).catch(() => {
    // A missing cache file is already evicted.
  });
}

function makeRoomFor(bytes: number): boolean {
  if (bytes > MAX_HISTORY_ATTACHMENT_CACHE_BYTES) {
    return false;
  }
  for (const [id, entry] of cachedAttachments) {
    if (
      cachedBytes + bytes <= MAX_HISTORY_ATTACHMENT_CACHE_BYTES &&
      cachedAttachments.size < MAX_HISTORY_ATTACHMENT_CACHE_ENTRIES
    ) {
      break;
    }
    // A materializing entry owns a live background process. It stays pinned
    // until that finite operation resolves, preventing orphaned temp files.
    if (entry.materializing) {
      continue;
    }
    discardEntry(id, entry);
  }
  return (
    cachedBytes + bytes <= MAX_HISTORY_ATTACHMENT_CACHE_BYTES &&
    cachedAttachments.size < MAX_HISTORY_ATTACHMENT_CACHE_ENTRIES
  );
}

function estimatedBase64Bytes(encoded: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}

function isPlausibleImagePrefix(bytes: Buffer, mediaType: string): boolean {
  switch (mediaType) {
    case "image/png":
      return (
        bytes.byteLength >= 8 &&
        bytes.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
      );
    case "image/jpeg":
      return (
        bytes.byteLength >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      );
    case "image/gif":
      return /^(?:GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii"));
    case "image/webp":
      return (
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case "image/svg+xml":
      return /^(?:<\?xml[\s\S]*?>\s*)?<svg[\s>]/i.test(
        bytes.subarray(0, Math.min(bytes.byteLength, 1_024)).toString("utf8").trimStart(),
      );
    case "image/heic":
    case "image/avif":
      return bytes.subarray(4, 12).toString("ascii").includes("ftyp");
    default:
      return false;
  }
}

function dataUrlPayload(
  dataUrl: string,
): { mediaType: string; encodedBase64: string; size: number } | null {
  const comma = dataUrl.indexOf(",");
  if (comma <= 5) {
    return null;
  }
  const metadata = dataUrl.slice(5, comma);
  if (!/(?:^|;)base64(?:;|$)/i.test(metadata)) {
    return null;
  }
  const mediaType = normalizedMediaType(metadata.split(";", 1)[0] ?? "");
  if (!mediaType) {
    return null;
  }
  const encodedBase64 = dataUrl.slice(comma + 1);
  if (
    encodedBase64.length === 0 ||
    encodedBase64.length % 4 === 1 ||
    encodedBase64.length > Math.ceil(MAX_HISTORY_ATTACHMENT_BYTES / 3) * 4 + 4
  ) {
    return null;
  }
  const head = encodedBase64.slice(0, VALIDATION_SAMPLE_CHARS);
  const tail = encodedBase64.slice(-VALIDATION_SAMPLE_CHARS);
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(head) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(tail)
  ) {
    return null;
  }
  const size = estimatedBase64Bytes(encodedBase64);
  if (size <= 0 || size > MAX_HISTORY_ATTACHMENT_BYTES) {
    return null;
  }
  const prefix = Buffer.from(head, "base64");
  return isPlausibleImagePrefix(prefix, mediaType)
    ? { mediaType, encodedBase64, size }
    : null;
}

function boundedDataUrlFingerprint(
  mediaType: string,
  encodedBase64: string,
): string {
  const hash = createHash("sha256")
    .update(mediaType)
    .update("\0")
    .update(String(encodedBase64.length))
    .update("\0")
    .update(encodedBase64.slice(0, FINGERPRINT_SAMPLE_BYTES));
  if (encodedBase64.length > FINGERPRINT_SAMPLE_BYTES) {
    hash
      .update("\0")
      .update(encodedBase64.slice(-FINGERPRINT_SAMPLE_BYTES));
  }
  return hash.digest("hex");
}

function dataUrlFromContentPart(part: Record<string, unknown>): string | null {
  for (const key of ["image_url", "imageUrl", "url"] as const) {
    const value = part[key];
    if (typeof value === "string" && value.startsWith("data:image/")) {
      return value;
    }
  }
  return null;
}

async function materializeDataUrlAttachment(
  id: string,
  entry: CachedProviderHistoryAttachment,
): Promise<string> {
  if (entry.attachment.path) {
    return entry.attachment.path;
  }
  if (entry.materializing) {
    return await entry.materializing;
  }
  const encodedBase64 = entry.encodedBase64;
  if (!encodedBase64) {
    throw new Error(`Provider history attachment ${id} is unavailable.`);
  }

  const materializing = (async () => {
    const root = await ensureCacheRoot();
    const digest = id.slice(HISTORY_ATTACHMENT_ID_PREFIX.length);
    const target = join(
      root,
      `${digest}${mediaTypeExtension(entry.attachment.mediaType)}`,
    );
    await sharedHistoryWorkloadScheduler.schedule(
      async (signal) => {
        await runBackgroundCommand({
          command: process.execPath,
          args: [
            "-e",
            MATERIALIZE_IMAGE_SCRIPT,
            target,
            entry.attachment.mediaType,
            String(entry.attachment.size),
            String(encodedBase64.length),
          ],
          input: encodedBase64,
          signal,
          label: "provider history image materialization",
          timeoutMs: 30_000,
          maxStdoutBytes: 0,
          maxStderrBytes: 64 * 1024,
        });
      },
      { priority: HISTORY_WORKLOAD_PRIORITY.interactive },
    );
    const stats = await stat(target);
    if (!stats.isFile() || stats.size !== entry.attachment.size) {
      await unlink(target).catch(() => undefined);
      throw new Error(`Provider history attachment ${id} failed validation.`);
    }
    const previousWeight = entry.cacheWeight;
    entry.attachment.path = target;
    entry.cacheWeight = stats.size;
    delete entry.encodedBase64;
    cachedBytes = Math.max(0, cachedBytes - previousWeight) + entry.cacheWeight;
    return target;
  })();
  entry.materializing = materializing;
  try {
    return await materializing;
  } finally {
    delete entry.materializing;
  }
}

export function cacheProviderHistoryImageDataUrl(
  dataUrl: string,
  name?: string,
): SessionInputAttachment | null {
  const payload = dataUrlPayload(dataUrl);
  if (!payload) {
    return null;
  }
  const digest = boundedDataUrlFingerprint(
    payload.mediaType,
    payload.encodedBase64,
  );
  const id = `${HISTORY_ATTACHMENT_ID_PREFIX}${digest}`;
  const existing = cachedAttachments.get(id);
  if (existing) {
    touchEntry(id, existing);
    return publicAttachment(existing.attachment);
  }
  const cacheWeight = payload.encodedBase64.length;
  if (!makeRoomFor(cacheWeight)) {
    return null;
  }
  const attachment: ProviderHistoryAttachment = {
    id,
    kind: "image",
    name: safeAttachmentName(name, payload.mediaType),
    mediaType: payload.mediaType,
    size: payload.size,
  };
  cachedAttachments.set(id, {
    attachment,
    owned: true,
    cacheWeight,
    encodedBase64: payload.encodedBase64,
  });
  cachedBytes += cacheWeight;
  return publicAttachment(attachment);
}

export function cacheProviderHistoryImageParts(
  content: unknown,
  names: readonly string[] = [],
): SessionInputAttachment[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const attachments: SessionInputAttachment[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const dataUrl = dataUrlFromContentPart(item as Record<string, unknown>);
    if (!dataUrl) {
      continue;
    }
    const attachment = cacheProviderHistoryImageDataUrl(
      dataUrl,
      names[attachments.length],
    );
    if (attachment) {
      attachments.push(attachment);
    }
  }
  return attachments;
}

/**
 * Register a trusted provider-owned path without touching the filesystem.
 *
 * History translation is synchronous and latency-sensitive. Availability and
 * exact size are verified only when a preview is requested, keeping `stat`
 * off the daemon event loop while still preserving a stable image marker.
 */
export function registerProviderHistoryImagePath(
  candidatePath: string,
  name?: string,
): SessionInputAttachment | null {
  const mediaType = mediaTypeFromPath(candidatePath);
  if (!mediaType) {
    return null;
  }
  const digest = createHash("sha256")
    .update("path\0")
    .update(candidatePath)
    .digest("hex");
  const id = `${HISTORY_PATH_ATTACHMENT_ID_PREFIX}${digest}`;
  const existing = cachedAttachments.get(id);
  if (existing) {
    touchEntry(id, existing);
    return publicAttachment(existing.attachment);
  }
  if (!makeRoomFor(1)) {
    return null;
  }
  const attachment: ProviderHistoryAttachment = {
    id,
    kind: "image",
    name: safeAttachmentName(name ?? basename(candidatePath), mediaType),
    mediaType,
    size: 0,
    path: candidatePath,
  };
  cachedAttachments.set(id, {
    attachment,
    owned: false,
    cacheWeight: 1,
  });
  cachedBytes += 1;
  return publicAttachment(attachment);
}

/**
 * Return a path already known to the cache without filesystem I/O. This is
 * used only for forwarding an attachment to a provider; preview requests use
 * the verified asynchronous resolver below.
 */
export function providerHistoryAttachmentReference(
  id: string,
): ResolvedProviderHistoryAttachment | null {
  const entry = cachedAttachments.get(id);
  const path = entry?.attachment.path;
  if (!entry || !path) {
    return null;
  }
  touchEntry(id, entry);
  return { ...entry.attachment, path };
}

export async function resolveProviderHistoryAttachment(
  id: string,
): Promise<ResolvedProviderHistoryAttachment | null> {
  if (
    !id.startsWith(HISTORY_ATTACHMENT_ID_PREFIX) &&
    !id.startsWith(HISTORY_PATH_ATTACHMENT_ID_PREFIX)
  ) {
    return null;
  }
  const entry = cachedAttachments.get(id);
  if (!entry) {
    return null;
  }
  try {
    const path =
      entry.attachment.path ??
      (await materializeDataUrlAttachment(id, entry));
    const stats = await stat(path);
    if (
      !stats.isFile() ||
      stats.size <= 0 ||
      stats.size > MAX_HISTORY_ATTACHMENT_BYTES ||
      (entry.attachment.size > 0 && stats.size !== entry.attachment.size)
    ) {
      discardEntry(id, entry);
      return null;
    }
    entry.attachment.size = stats.size;
    touchEntry(id, entry);
    return { ...entry.attachment, path };
  } catch {
    discardEntry(id, entry);
    return null;
  }
}

export function isProviderHistoryPathAttachmentId(id: string): boolean {
  return id.startsWith(HISTORY_PATH_ATTACHMENT_ID_PREFIX);
}
