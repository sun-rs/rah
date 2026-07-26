export type BottomFollowSettleState = {
  remainingFrames: number;
  previousExtent: number | null;
};

export type BottomFollowSettleSample = {
  extent: number;
  moved: boolean;
};

export function createBottomFollowSettleState(
  maximumFrames: number,
): BottomFollowSettleState {
  return {
    remainingFrames: Math.max(1, Math.floor(maximumFrames)),
    previousExtent: null,
  };
}

/**
 * Bottom-follow is driven primarily by ResizeObserver. This bounded fallback
 * only spans enough animation frames to cover a virtual-window mount or a
 * foreground layout transition, and stops as soon as one stable frame is
 * observed.
 */
export function advanceBottomFollowSettle(
  state: BottomFollowSettleState,
  sample: BottomFollowSettleSample,
): {
  state: BottomFollowSettleState;
  shouldContinue: boolean;
} {
  const remainingFrames = Math.max(0, state.remainingFrames - 1);
  const extentStable =
    state.previousExtent !== null &&
    Math.abs(state.previousExtent - sample.extent) < 0.5;
  const settled = extentStable && !sample.moved;
  return {
    state: {
      remainingFrames,
      previousExtent: sample.extent,
    },
    shouldContinue: remainingFrames > 0 && !settled,
  };
}
