import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import type {
  SessionInputAttachment,
  SessionInputAttachmentKind,
} from "@rah/runtime-protocol";
import {
  providerHistoryAttachmentReference,
  resolveProviderHistoryAttachment,
} from "./provider-history-attachments";

export const MAX_DEVICE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type StoredDeviceAttachment = SessionInputAttachment & {
  storedName: string;
  createdAt: string;
};

export type ResolvedSessionInputAttachment = SessionInputAttachment & {
  path: string;
};

const MAX_CACHED_ATTACHMENT_RECORDS = 2_048;
const cachedAttachmentRecords = new Map<string, StoredDeviceAttachment>();

function attachmentRoot(): string {
  return join(process.env.RAH_HOME ?? join(homedir(), ".rah"), "attachments");
}

function normalizeMediaType(value: string | undefined): string {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType || "application/octet-stream";
}

function attachmentKind(mediaType: string): SessionInputAttachmentKind {
  return mediaType.startsWith("image/") ? "image" : "file";
}

function mediaTypeFromName(name: string): string {
  switch (extname(name).toLowerCase()) {
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
      return "application/octet-stream";
  }
}

function safeStoredName(value: string | undefined): string {
  const source = basename(value?.trim() || "attachment");
  const normalized = source
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:]/g, "-")
    .trim();
  const name = normalized === "." || normalized === ".." ? "attachment" : normalized;
  return (name || "attachment").slice(0, 180);
}

function assertAttachmentId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Unknown attachment ${id}.`);
  }
}

function attachmentDirectory(id: string): string {
  assertAttachmentId(id);
  return join(attachmentRoot(), id);
}

function publicAttachment(record: StoredDeviceAttachment): SessionInputAttachment {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    mediaType: record.mediaType,
    size: record.size,
  };
}

function rememberAttachmentRecord(record: StoredDeviceAttachment): void {
  cachedAttachmentRecords.delete(record.id);
  cachedAttachmentRecords.set(record.id, record);
  while (cachedAttachmentRecords.size > MAX_CACHED_ATTACHMENT_RECORDS) {
    const oldestId = cachedAttachmentRecords.keys().next().value as
      | string
      | undefined;
    if (!oldestId) {
      break;
    }
    cachedAttachmentRecords.delete(oldestId);
  }
}

function resolvedAttachmentReference(
  attachment: SessionInputAttachment,
): ResolvedSessionInputAttachment {
  const providerHistoryAttachment = providerHistoryAttachmentReference(
    attachment.id,
  );
  if (providerHistoryAttachment) {
    return providerHistoryAttachment;
  }
  const directory = attachmentDirectory(attachment.id);
  const name = safeStoredName(attachment.name);
  const mediaType = normalizeMediaType(attachment.mediaType);
  const size = Number.isInteger(attachment.size)
    ? Math.max(0, Math.min(MAX_DEVICE_ATTACHMENT_BYTES, attachment.size))
    : 0;
  return {
    id: attachment.id,
    kind: attachmentKind(mediaType),
    name,
    mediaType,
    size,
    path: join(directory, `content-${name}`),
  };
}

export async function saveDeviceAttachment(args: {
  bytes: Buffer;
  name?: string;
  mediaType?: string;
}): Promise<SessionInputAttachment> {
  if (args.bytes.byteLength <= 0) {
    throw new Error("Bad Request: attachment body is empty.");
  }
  if (args.bytes.byteLength > MAX_DEVICE_ATTACHMENT_BYTES) {
    throw new Error("Request body too large.");
  }

  const id = randomUUID();
  const directory = attachmentDirectory(id);
  const name = safeStoredName(args.name);
  const storedName = `content-${name}`;
  const mediaType = normalizeMediaType(args.mediaType);
  const record: StoredDeviceAttachment = {
    id,
    kind: attachmentKind(mediaType),
    name,
    mediaType,
    size: args.bytes.byteLength,
    storedName,
    createdAt: new Date().toISOString(),
  };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, storedName), args.bytes, { mode: 0o600 });
  await writeFile(join(directory, "metadata.json"), `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  rememberAttachmentRecord(record);
  return publicAttachment(record);
}

export async function resolveDeviceAttachment(
  id: string,
): Promise<ResolvedSessionInputAttachment> {
  const providerHistoryAttachment = await resolveProviderHistoryAttachment(id);
  if (providerHistoryAttachment) {
    return providerHistoryAttachment;
  }
  const directory = attachmentDirectory(id);
  let record: StoredDeviceAttachment;
  try {
    record = JSON.parse(
      await readFile(join(directory, "metadata.json"), "utf8"),
    ) as StoredDeviceAttachment;
  } catch {
    throw new Error(`Unknown attachment ${id}.`);
  }
  if (
    record.id !== id ||
    (record.kind !== "image" && record.kind !== "file") ||
    typeof record.name !== "string" ||
    typeof record.mediaType !== "string" ||
    typeof record.size !== "number" ||
    typeof record.storedName !== "string"
  ) {
    throw new Error(`Unknown attachment ${id}.`);
  }

  const path = resolve(directory, record.storedName);
  const directoryPrefix = `${resolve(directory)}${sep}`;
  if (!path.startsWith(directoryPrefix)) {
    throw new Error(`Unknown attachment ${id}.`);
  }
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size !== record.size) {
      throw new Error("invalid attachment file");
    }
  } catch {
    throw new Error(`Unknown attachment ${id}.`);
  }
  rememberAttachmentRecord(record);
  return { ...publicAttachment(record), path };
}

/**
 * Recover public attachment metadata from a managed persisted path without
 * touching disk. The exact metadata and file integrity are checked later by
 * `resolveDeviceAttachment` when a preview is actually requested.
 */
export function describeManagedAttachmentPath(
  candidatePath: string,
): SessionInputAttachment | null {
  const root = resolve(attachmentRoot());
  const target = resolve(candidatePath);
  const rootPrefix = `${root}${sep}`;
  if (!target.startsWith(rootPrefix)) {
    return null;
  }
  const relativeParts = target.slice(rootPrefix.length).split(sep);
  const [id, storedName, ...remaining] = relativeParts;
  if (!id || !storedName || remaining.length > 0) {
    return null;
  }
  try {
    assertAttachmentId(id);
  } catch {
    return null;
  }
  const cached = cachedAttachmentRecords.get(id);
  if (cached) {
    const cachedPath = resolve(attachmentDirectory(id), cached.storedName);
    if (cachedPath !== target) {
      return null;
    }
    rememberAttachmentRecord(cached);
    return publicAttachment(cached);
  }
  if (!storedName.startsWith("content-")) {
    return null;
  }
  const name = safeStoredName(storedName.slice("content-".length));
  const mediaType = mediaTypeFromName(name);
  return {
    id,
    kind: attachmentKind(mediaType),
    name,
    mediaType,
    size: 0,
  };
}

export async function resolveManagedAttachmentPath(
  candidatePath: string,
): Promise<ResolvedSessionInputAttachment | null> {
  const described = describeManagedAttachmentPath(candidatePath);
  if (!described) {
    return null;
  }
  try {
    const attachment = await resolveDeviceAttachment(described.id);
    return attachment.path === resolve(candidatePath) ? attachment : null;
  } catch {
    return null;
  }
}

export function resolveDeviceAttachments(
  attachments: readonly SessionInputAttachment[] | undefined,
): ResolvedSessionInputAttachment[] {
  return (attachments ?? []).map(resolvedAttachmentReference);
}
