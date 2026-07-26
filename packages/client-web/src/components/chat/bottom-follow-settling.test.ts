import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceBottomFollowSettle,
  createBottomFollowSettleState,
} from "./bottom-follow-settling.js";

test("bottom follow stops after the first stable follow-up frame", () => {
  let state = createBottomFollowSettleState(8);
  let advanced = advanceBottomFollowSettle(state, {
    extent: 1_000,
    moved: true,
  });
  assert.equal(advanced.shouldContinue, true);

  state = advanced.state;
  advanced = advanceBottomFollowSettle(state, {
    extent: 1_000,
    moved: false,
  });
  assert.equal(advanced.shouldContinue, false);
  assert.equal(advanced.state.remainingFrames, 6);
});

test("bottom follow keeps settling while virtual content changes size", () => {
  let state = createBottomFollowSettleState(4);
  let advanced = advanceBottomFollowSettle(state, {
    extent: 1_000,
    moved: true,
  });
  state = advanced.state;
  advanced = advanceBottomFollowSettle(state, {
    extent: 1_240,
    moved: true,
  });
  assert.equal(advanced.shouldContinue, true);

  state = advanced.state;
  advanced = advanceBottomFollowSettle(state, {
    extent: 1_240,
    moved: false,
  });
  assert.equal(advanced.shouldContinue, false);
});

test("bottom follow remains bounded when every frame changes", () => {
  let state = createBottomFollowSettleState(2);
  let advanced = advanceBottomFollowSettle(state, {
    extent: 100,
    moved: true,
  });
  assert.equal(advanced.shouldContinue, true);

  state = advanced.state;
  advanced = advanceBottomFollowSettle(state, {
    extent: 200,
    moved: true,
  });
  assert.equal(advanced.shouldContinue, false);
  assert.equal(advanced.state.remainingFrames, 0);
});
