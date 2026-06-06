export type ChatTab = "active" | "all" | "council";

export function shouldLoadAllStoredSessionsForDialog(open: boolean, tab: ChatTab): boolean {
  return open && tab === "all";
}
