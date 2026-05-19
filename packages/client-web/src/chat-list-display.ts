export type ChatListSubtitleCandidate = {
  text?: string | null | undefined;
  label?: string | null | undefined;
};

export function compactChatListText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedChatListText(value: string | null | undefined): string {
  return compactChatListText(value).toLocaleLowerCase();
}

export function isSameChatListText(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizedChatListText(left);
  const normalizedRight = normalizedChatListText(right);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

export function chooseChatListSubtitle(
  title: string,
  candidates: readonly ChatListSubtitleCandidate[],
): string | null {
  for (const candidate of candidates) {
    const text = compactChatListText(candidate.text);
    if (!text) {
      continue;
    }
    const label = compactChatListText(candidate.label);
    const formatted = label ? `${label}: ${text}` : text;
    if (isSameChatListText(title, text) || isSameChatListText(title, formatted)) {
      continue;
    }
    return formatted;
  }
  return null;
}
