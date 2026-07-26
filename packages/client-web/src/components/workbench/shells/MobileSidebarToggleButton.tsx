import { Menu } from "lucide-react";
import {
  HEADER_EDGE_TOGGLE_BUTTON_BASE_CLASS,
  HEADER_EDGE_TOGGLE_ICON_SIZE,
} from "../header-button-styles";

export const MOBILE_SIDEBAR_TOGGLE_POSITION_CLASS =
  "fixed left-2 top-[calc(env(safe-area-inset-top,0px)+0.5rem)] z-40";

export function MobileSidebarToggleButton(props: {
  className?: string;
  onOpen: () => void;
}) {
  return (
    <span className={`inline-flex h-8 w-8 shrink-0 ${props.className ?? ""}`}>
      <button
        type="button"
        className={`${HEADER_EDGE_TOGGLE_BUTTON_BASE_CLASS} ${MOBILE_SIDEBAR_TOGGLE_POSITION_CLASS} inline-flex`}
        onClick={props.onOpen}
        aria-label="Open sidebar"
        title="Open sidebar"
      >
        <Menu size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
      </button>
    </span>
  );
}
