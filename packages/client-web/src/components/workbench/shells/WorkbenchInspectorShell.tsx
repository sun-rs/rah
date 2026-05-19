import type { ReactNode } from "react";
import { ConversationSidePanelShell } from "./ConversationSidePanelShell";

export function WorkbenchInspectorShell(props: {
  showDesktop: boolean;
  desktopOpen: boolean;
  rightOpen: boolean;
  onRightOpenChange: (open: boolean) => void;
  onToggle: () => void;
  content: ReactNode;
}) {
  return (
    <ConversationSidePanelShell
      desktopOpen={props.desktopOpen}
      showDesktop={props.showDesktop}
      mobileOpen={props.rightOpen}
      onMobileOpenChange={props.onRightOpenChange}
      mobileTitle="Inspector"
      mobileFloatingCloseLabel="Collapse inspector"
      toggleLabel={props.desktopOpen ? "Collapse inspector" : "Expand inspector"}
      onToggle={props.onToggle}
    >
      {props.content}
    </ConversationSidePanelShell>
  );
}
