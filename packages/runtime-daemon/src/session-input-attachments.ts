import { pathToFileURL } from "node:url";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type {
  SessionInputAttachment,
  SessionInputRequest,
} from "@rah/runtime-protocol";
import {
  describeManagedAttachmentPath,
  resolveDeviceAttachments,
  type ResolvedSessionInputAttachment,
} from "./device-attachments";
import { registerProviderHistoryImagePath } from "./provider-history-attachments";

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
  mentionedFiles: Array<{ name: string; path: string }>;
  annotations: Array<{ text: string; annotation?: string }>;
}

const PERSISTED_IMAGE_BLOCK_PATTERN =
  /<image\b(?=[^>]*\bpath="([^"\r\n]+)")[^>]*>\s*<\/image>/gi;
const CODEX_FILE_MENTION_ENVELOPE_PATTERN =
  /^\s*# Files mentioned by the user:\s*\n([\s\S]*?)\n## My request for Codex:\s*\n([\s\S]*)$/;
const CODEX_FILE_MENTION_PATTERN = /^## (.+?): (.+)$/gm;
const RESPONSE_ANNOTATION_ENVELOPE_PATTERN =
  /^\s*# Response annotations:\s*\n[\s\S]*?\n<response-annotations>\s*\n([\s\S]*?)\n<\/response-annotations>\s*\n?([\s\S]*)$/;
const REMOTE_ATTACHMENT_ROOTS = [
  resolve("/tmp/codex-remote-attachments"),
  resolve("/private/tmp/codex-remote-attachments"),
  resolve(tmpdir()),
];

function isTrustedRemoteAttachmentPath(candidatePath: string): boolean {
  const target = resolve(candidatePath);
  return REMOTE_ATTACHMENT_ROOTS.some(
    (root) => target === root || target.startsWith(`${root}${sep}`),
  );
}

function unwrapCodexFileMentionEnvelope(content: string): {
  text: string;
  mentionedFiles: Array<{ name: string; path: string }>;
} {
  const envelope = CODEX_FILE_MENTION_ENVELOPE_PATTERN.exec(content);
  if (!envelope) {
    return { text: content, mentionedFiles: [] };
  }
  const mentionedFiles: Array<{ name: string; path: string }> = [];
  for (const match of envelope[1]!.matchAll(CODEX_FILE_MENTION_PATTERN)) {
    const name = match[1]?.trim();
    const path = match[2]?.trim();
    if (name && path) {
      mentionedFiles.push({ name, path });
    }
  }
  return {
    text: envelope[2] ?? "",
    mentionedFiles,
  };
}

export function parseResponseAnnotationEnvelope(content: string): {
  text: string;
  annotations: Array<{ text: string; annotation?: string }>;
} {
  const envelope = RESPONSE_ANNOTATION_ENVELOPE_PATTERN.exec(content);
  if (!envelope) {
    return { text: content, annotations: [] };
  }
  try {
    const parsed = JSON.parse(envelope[1] ?? "") as unknown;
    if (!Array.isArray(parsed)) {
      return { text: content, annotations: [] };
    }
    const annotations: Array<{ text: string; annotation?: string }> = [];
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return { text: content, annotations: [] };
      }
      const record = candidate as Record<string, unknown>;
      if (typeof record.text !== "string" || !record.text.trim()) {
        return { text: content, annotations: [] };
      }
      if (record.annotation !== undefined && typeof record.annotation !== "string") {
        return { text: content, annotations: [] };
      }
      const annotation = record.annotation?.trim();
      annotations.push({
        text: record.text.trim(),
        ...(annotation ? { annotation } : {}),
      });
    }
    if (annotations.length === 0) {
      return { text: content, annotations: [] };
    }
    return { text: envelope[2] ?? "", annotations };
  } catch {
    return { text: content, annotations: [] };
  }
}

export function parsePersistedUserMessageContent(
  content: string,
): PersistedUserMessageContent {
  const annotationEnvelope = parseResponseAnnotationEnvelope(content);
  const unwrapped = unwrapCodexFileMentionEnvelope(annotationEnvelope.text);
  const attachments = new Map<string, SessionInputAttachment>();
  let imageCount = 0;
  const text = unwrapped.text
    .replace(PERSISTED_IMAGE_BLOCK_PATTERN, (block, candidatePath: string) => {
      const attachment = describeManagedAttachmentPath(candidatePath);
      if (attachment?.kind === "image") {
        attachments.set(attachment.id, attachment);
        imageCount += 1;
        return "";
      }
      const mentionedFile = unwrapped.mentionedFiles.find(
        (file) => resolve(file.path) === resolve(candidatePath),
      );
      if (mentionedFile || isTrustedRemoteAttachmentPath(candidatePath)) {
        const remoteAttachment = isTrustedRemoteAttachmentPath(candidatePath)
          ? registerProviderHistoryImagePath(
              candidatePath,
              mentionedFile?.name,
            )
          : null;
        if (remoteAttachment) {
          attachments.set(remoteAttachment.id, remoteAttachment);
        }
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
    mentionedFiles: unwrapped.mentionedFiles,
    annotations: annotationEnvelope.annotations,
  };
}

export function textWithResponseAnnotations(request: SessionInputRequest): string {
  const annotations = request.annotations
    ?.map((item) => ({
      text: item.text.trim(),
      ...(item.annotation?.trim() ? { annotation: item.annotation.trim() } : {}),
    }))
    .filter((item) => item.text);
  if (!annotations?.length) {
    return request.text;
  }
  const block = [
    "# Response annotations:",
    "Each item contains text selected from an earlier assistant response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. When addressing multiple comments, label each answer with its annotation number so the user can match it to the numbered annotation.",
    "<response-annotations>",
    JSON.stringify(annotations),
    "</response-annotations>",
  ].join("\n");
  return request.text.trim() ? `${block}\n\n${request.text}` : block;
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
    textWithResponseAnnotations(request),
    resolveDeviceAttachments(request.attachments),
  );
}

export function codexTurnInput(request: SessionInputRequest): CodexTurnInput[] {
  const attachments = resolveDeviceAttachments(request.attachments);
  const nonImages = attachments.filter((attachment) => attachment.kind !== "image");
  const text = textWithAttachmentPaths(textWithResponseAnnotations(request), nonImages);
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
  const text = textWithResponseAnnotations(request);
  if (text.trim()) {
    parts.push({ type: "text", text });
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
