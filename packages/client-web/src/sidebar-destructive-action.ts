export const SIDEBAR_DESTRUCTIVE_ACTION_ARM_TIMEOUT_MS = 2_000;

export type SidebarDestructiveActionTransition = {
  armed: boolean;
  execute: boolean;
};

export function advanceSidebarDestructiveAction(
  armed: boolean,
): SidebarDestructiveActionTransition {
  return armed
    ? { armed: false, execute: true }
    : { armed: true, execute: false };
}
