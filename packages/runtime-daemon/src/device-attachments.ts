import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type {
  SessionInputAttachment,
  SessionInputAttachmentKind,
} from "@rah/runtime-protocol";

export const MAX_DEVICE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type StoredDeviceAttachment = SessionInputAttachment & {
  storedName: string;
  createdAt: string;
};

export type ResolvedSessionInputAttachment = SessionInputAttachment & {
  path: string;
};

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
  return publicAttachment(record);
}

export function resolveDeviceAttachment(id: string): ResolvedSessionInputAttachment {
  const directory = attachmentDirectory(id);
  let record: StoredDeviceAttachment;
  try {
    record = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8")) as StoredDeviceAttachment;
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
    const file = statSync(path);
    if (!file.isFile() || file.size !== record.size) {
      throw new Error("invalid attachment file");
    }
  } catch {
    throw new Error(`Unknown attachment ${id}.`);
  }
  return { ...publicAttachment(record), path };
}

export function resolveManagedAttachmentPath(
  candidatePath: string,
): ResolvedSessionInputAttachment | null {
  const root = resolve(attachmentRoot());
  const target = resolve(candidatePath);
  const rootPrefix = `${root}${sep}`;
  if (!target.startsWith(rootPrefix)) {
    return null;
  }
  const [id] = target.slice(rootPrefix.length).split(sep);
  if (!id) {
    return null;
  }
  try {
    const attachment = resolveDeviceAttachment(id);
    return attachment.path === target ? attachment : null;
  } catch {
    return null;
  }
}

export function resolveDeviceAttachments(
  attachments: readonly SessionInputAttachment[] | undefined,
): ResolvedSessionInputAttachment[] {
  return (attachments ?? []).map((attachment) => resolveDeviceAttachment(attachment.id));
}
