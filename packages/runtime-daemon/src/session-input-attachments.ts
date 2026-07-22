import { pathToFileURL } from "node:url";
import { resolve, sep } from "node:path";
import type {
  SessionInputAttachment,
  SessionInputRequest,
} from "@rah/runtime-protocol";
import {
  resolveManagedAttachmentPath,
  resolveDeviceAttachments,
  type ResolvedSessionInputAttachment,
} from "./device-attachments";

export type CodexTurnInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string };

export type OpenCodePromptPart =
  | { type: "text"; text: string }
  | {
      type: "file";
      mime: string;
      filename: string;
      url: string;
    };

export interface PersistedUserMessageContent {
  text: string;
  attachments: SessionInputAttachment[];
  imageCount: number;
}

const PERSISTED_IMAGE_BLOCK_PATTERN =
  /<image\b(?=[^>]*\bpath="([^"\r\n]+)")[^>]*>\s*<\/image>/gi;
const REMOTE_ATTACHMENT_ROOTS = [
  resolve("/tmp/codex-remote-attachments"),
  resolve("/private/tmp/codex-remote-attachments"),
];

function isTrustedRemoteAttachmentPath(candidatePath: string): boolean {
  const target = resolve(candidatePath);
  return REMOTE_ATTACHMENT_ROOTS.some(
    (root) => target === root || target.startsWith(`${root}${sep}`),
  );
}

export function parsePersistedUserMessageContent(
  content: string,
): PersistedUserMessageContent {
  const attachments = new Map<string, SessionInputAttachment>();
  let imageCount = 0;
  const text = content
    .replace(PERSISTED_IMAGE_BLOCK_PATTERN, (block, candidatePath: string) => {
      const attachment = resolveManagedAttachmentPath(candidatePath);
      if (attachment?.kind === "image") {
        const { path: _path, ...publicAttachment } = attachment;
        attachments.set(attachment.id, publicAttachment);
        imageCount += 1;
        return "";
      }
      if (isTrustedRemoteAttachmentPath(candidatePath)) {
        imageCount += 1;
        return "";
      }
      return block;
    })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join("\n")
    .trim();
  return {
    text,
    attachments: [...attachments.values()],
    imageCount,
  };
}

function attachmentPathBlock(
  attachments: readonly ResolvedSessionInputAttachment[],
): string {
  if (attachments.length === 0) {
    return "";
  }
  return [
    "Attached files (available on the RAH host):",
    ...attachments.map((attachment) => `- ${attachment.path}`),
  ].join("\n");
}

function textWithAttachmentPaths(
  text: string,
  attachments: readonly ResolvedSessionInputAttachment[],
): string {
  const block = attachmentPathBlock(attachments);
  if (!block) {
    return text;
  }
  return text.trim() ? `${text}\n\n${block}` : block;
}

export function nativeTuiInputText(request: SessionInputRequest): string {
  return textWithAttachmentPaths(
    request.text,
    resolveDeviceAttachments(request.attachments),
  );
}

export function codexTurnInput(request: SessionInputRequest): CodexTurnInput[] {
  const attachments = resolveDeviceAttachments(request.attachments);
  const nonImages = attachments.filter((attachment) => attachment.kind !== "image");
  const text = textWithAttachmentPaths(request.text, nonImages);
  const input: CodexTurnInput[] = [];
  if (text.trim()) {
    input.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      input.push({ type: "localImage", path: attachment.path });
    }
  }
  return input;
}

export function openCodePromptParts(
  request: SessionInputRequest,
): OpenCodePromptPart[] {
  const attachments = resolveDeviceAttachments(request.attachments);
  const parts: OpenCodePromptPart[] = [];
  if (request.text.trim()) {
    parts.push({ type: "text", text: request.text });
  }
  for (const attachment of attachments) {
    parts.push({
      type: "file",
      mime: attachment.mediaType,
      filename: attachment.name,
      url: pathToFileURL(attachment.path).href,
    });
  }
  return parts;
}
