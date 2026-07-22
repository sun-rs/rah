import type { ReactNode } from "react";
import { ConversationSidePanelShell } from "./ConversationSidePanelShell";

export function WorkbenchInspectorShell(props: {
  showDesktop: boolean;
  desktopOpen: boolean;
  rightOpen?: boolean;
  onRightOpenChange?: (open: boolean) => void;
  content: ReactNode;
  contained?: boolean;
}) {
  const mobileProps =
    props.rightOpen === undefined || !props.onRightOpenChange
      ? {}
      : {
          mobileOpen: props.rightOpen,
          onMobileOpenChange: props.onRightOpenChange,
          mobileTitle: "Inspector",
          mobileFullScreen: true,
          mobileFloatingClose: false as const,
        };
  return (
    <ConversationSidePanelShell
      desktopOpen={props.desktopOpen}
      showDesktop={props.showDesktop}
      desktopBreakpoint="wide"
      desktopStorageKey="rah-inspector-panel-width"
      contained={props.contained === true}
      {...mobileProps}
    >
      {props.content}
    </ConversationSidePanelShell>
  );
}
