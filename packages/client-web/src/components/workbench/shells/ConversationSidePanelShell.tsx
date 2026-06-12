import type { CSSProperties, ReactNode } from "react";
import { PanelRight } from "lucide-react";
import { Sheet } from "../../Sheet";
import {
  HEADER_EDGE_TOGGLE_ICON_SIZE,
  HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS,
} from "../header-button-styles";

type ConversationSidePanelBreakpoint = "md" | "wide";

const SIDE_PANEL_TOGGLE_STYLE: CSSProperties = {
  position: "absolute",
  right: "0.5rem",
  top: "0.75rem",
};

function desktopClassNames(breakpoint: ConversationSidePanelBreakpoint): {
  aside: string;
  divider: string;
} {
  if (breakpoint === "wide") {
    return {
      aside: "hidden min-[900px]:flex",
      divider: "hidden min-[900px]:block",
    };
  }
  return {
    aside: "hidden md:flex",
    divider: "hidden md:block",
  };
}

export function ConversationSidePanelShell(props: {
  children: ReactNode;
  desktopOpen: boolean;
  showDesktop?: boolean;
  desktopBreakpoint?: ConversationSidePanelBreakpoint;
  desktopWidth?: string;
  desktopClassName?: string;
  desktopStyle?: CSSProperties;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
  mobileTitle?: ReactNode;
  mobileModal?: boolean;
  mobileFloatingCloseLabel?: string;
  toggleLabel?: string;
  toggleDisabled?: boolean;
  onToggle?: () => void;
}) {
  const breakpoint = props.desktopBreakpoint ?? "md";
  const classNames = desktopClassNames(breakpoint);
  const desktopWidth = props.desktopWidth ?? "clamp(20rem, 28vw, 28rem)";
  const showDesktop = props.showDesktop ?? true;
  const showMobile = props.mobileOpen !== undefined && props.onMobileOpenChange !== undefined;
  const mobileViewportClassName = breakpoint === "wide" ? "min-[900px]:hidden" : "md:hidden";

  return (
    <>
      {showDesktop ? (
        <>
          {props.desktopOpen ? (
            <div className={`inspector-divider ${classNames.divider}`} />
          ) : null}
          <aside
            className={`${classNames.aside} relative shrink-0 flex-col overflow-visible bg-transparent transition-[width] duration-200 ${
              props.desktopOpen ? "border-l border-[var(--app-border)]" : "border-l-0"
            } ${props.desktopClassName ?? ""}`}
            style={{
              width: props.desktopOpen ? desktopWidth : 0,
              ...props.desktopStyle,
            }}
          >
            {props.onToggle ? (
              <button
                type="button"
                className={`${HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS} z-30 bg-[var(--app-bg)]/90 backdrop-blur`}
                style={SIDE_PANEL_TOGGLE_STYLE}
                onClick={props.onToggle}
                disabled={props.toggleDisabled}
                aria-pressed={props.desktopOpen}
                aria-label={props.toggleLabel ?? "Hide panel"}
                title={props.toggleLabel ?? "Hide panel"}
              >
                <PanelRight size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
              </button>
            ) : null}
            <div className="h-full min-w-0 overflow-hidden bg-[var(--app-subtle-bg)]">
              {props.desktopOpen ? props.children : null}
            </div>
          </aside>
        </>
      ) : null}

      {showMobile ? (
        <Sheet
          open={props.mobileOpen ?? false}
          onOpenChange={props.onMobileOpenChange!}
          side="right"
          title={props.mobileTitle ?? "Details"}
          hideHeader
          viewportClassName={mobileViewportClassName}
          {...(props.mobileModal !== undefined ? { modal: props.mobileModal } : {})}
          floatingClose="x"
          floatingCloseLabel={props.mobileFloatingCloseLabel ?? "Hide panel"}
        >
          {props.children}
        </Sheet>
      ) : null}
    </>
  );
}
