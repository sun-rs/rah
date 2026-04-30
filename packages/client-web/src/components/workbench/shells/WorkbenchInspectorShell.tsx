import type { ReactNode } from "react";
import { Sheet } from "../../Sheet";

export function WorkbenchInspectorShell(props: {
  showDesktop: boolean;
  desktopOpen: boolean;
  rightOpen: boolean;
  onRightOpenChange: (open: boolean) => void;
  content: ReactNode;
}) {
  return (
    <>
      {props.showDesktop ? (
        <>
          {props.desktopOpen ? <div className="inspector-divider hidden md:block" /> : null}
          <aside
            className="hidden md:flex flex-col shrink-0 transition-[width] duration-200 overflow-hidden bg-[var(--app-subtle-bg)]"
            style={{ width: props.desktopOpen ? "clamp(20rem, 28vw, 28rem)" : 0 }}
          >
            {props.desktopOpen ? props.content : null}
          </aside>
        </>
      ) : null}

      <Sheet open={props.rightOpen} onOpenChange={props.onRightOpenChange} side="right" title="Inspector">
        {props.content}
      </Sheet>
    </>
  );
}
