import type { SessionInputAnnotation } from "@rah/runtime-protocol";

export const MAX_COMPOSER_ANNOTATIONS = 20;
export const MAX_COMPOSER_ANNOTATION_TEXT_LENGTH = 20_000;

export type SelectedConversationText = {
  text: string;
  source: NonNullable<SessionInputAnnotation["source"]>;
};

export function normalizeSelectedConversationText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_COMPOSER_ANNOTATION_TEXT_LENGTH);
}

export function createComposerAnnotation(
  selection: SelectedConversationText,
): SessionInputAnnotation | null {
  const text = normalizeSelectedConversationText(selection.text);
  if (!text) {
    return null;
  }
  const id =
    typeof globalThis.crypto === "object" &&
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `annotation:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    text,
    source: { ...selection.source },
  };
}

export function appendComposerAnnotation(
  current: readonly SessionInputAnnotation[],
  annotation: SessionInputAnnotation,
): SessionInputAnnotation[] {
  if (current.some((item) => item.id === annotation.id)) {
    return [...current];
  }
  return [...current, annotation].slice(-MAX_COMPOSER_ANNOTATIONS);
}
