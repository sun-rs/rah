import type { CouncilSnapshot } from "@rah/runtime-protocol";

export function councilActivityAt(council: CouncilSnapshot): string {
  const visibleMessage = [...council.messages]
    .reverse()
    .find((message) => message.role === "user" || message.role === "agent");
  return visibleMessage?.createdAt ??
    council.meta?.lastContentMessage?.createdAt ??
    council.createdAt;
}

export function councilActivityMs(council: CouncilSnapshot): number {
  return Date.parse(councilActivityAt(council)) || 0;
}
