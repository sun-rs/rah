export type SidebarSessionTooltipTarget = {
  key: string;
  anchor: object;
};

export type SidebarSessionTooltipState =
  | {
      phase: "idle";
      epoch: number;
    }
  | ({
      phase: "pending";
      epoch: number;
    } & SidebarSessionTooltipTarget)
  | ({
      phase: "open";
      epoch: number;
      source: "keyboard" | "pointer";
    } & SidebarSessionTooltipTarget);

export type SidebarSessionTooltipEvent =
  | ({ type: "pointer-enter" } & SidebarSessionTooltipTarget)
  | ({ type: "pointer-leave" } & SidebarSessionTooltipTarget)
  | ({ type: "keyboard-focus" } & SidebarSessionTooltipTarget)
  | {
      type: "delay-elapsed";
      epoch: number;
      eligible: boolean;
    }
  | { type: "cancel" };

export const INITIAL_SIDEBAR_SESSION_TOOLTIP_STATE: SidebarSessionTooltipState = {
  phase: "idle",
  epoch: 0,
};

function sameTarget(
  state: SidebarSessionTooltipState,
  target: SidebarSessionTooltipTarget,
): boolean {
  return state.phase !== "idle" &&
    state.key === target.key &&
    state.anchor === target.anchor;
}

function idleAfter(state: SidebarSessionTooltipState): SidebarSessionTooltipState {
  return state.phase === "idle"
    ? state
    : { phase: "idle", epoch: state.epoch + 1 };
}

export function reduceSidebarSessionTooltipState(
  state: SidebarSessionTooltipState,
  event: SidebarSessionTooltipEvent,
): SidebarSessionTooltipState {
  switch (event.type) {
    case "pointer-enter":
      if (sameTarget(state, event)) {
        return state;
      }
      return {
        phase: "pending",
        epoch: state.epoch + 1,
        key: event.key,
        anchor: event.anchor,
      };
    case "keyboard-focus":
      if (
        state.phase === "open" &&
        state.source === "keyboard" &&
        sameTarget(state, event)
      ) {
        return state;
      }
      return {
        phase: "open",
        epoch: state.epoch + 1,
        key: event.key,
        anchor: event.anchor,
        source: "keyboard",
      };
    case "pointer-leave":
      return sameTarget(state, event) ? idleAfter(state) : state;
    case "delay-elapsed":
      if (state.phase !== "pending" || state.epoch !== event.epoch) {
        return state;
      }
      if (!event.eligible) {
        return idleAfter(state);
      }
      return {
        phase: "open",
        epoch: state.epoch,
        key: state.key,
        anchor: state.anchor,
        source: "pointer",
      };
    case "cancel":
      return idleAfter(state);
  }
}
