import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  resolvePrependAnchorScrollTop,
  shouldMaintainDetachedReaderAnchor,
  shouldRequestOlderConversationHistory,
} from "./prepend-scroll-anchor.ts";

describe("prepend scroll anchor", () => {
  test("keeps the same message at the same viewport offset", () => {
    assert.equal(
      resolvePrependAnchorScrollTop({
        currentScrollTop: 240,
        anchorScrollTop: 240,
        currentScrollHeight: 2_400,
        anchorScrollHeight: 1_600,
        currentViewportOffset: 118,
        anchorViewportOffset: 38,
      }),
      320,
    );
  });

  test("falls back to the prepended height delta when the keyed row is not mounted", () => {
    assert.equal(
      resolvePrependAnchorScrollTop({
        currentScrollTop: 240,
        anchorScrollTop: 240,
        currentScrollHeight: 2_400,
        anchorScrollHeight: 1_600,
        currentViewportOffset: null,
        anchorViewportOffset: 38,
      }),
      1_040,
    );
  });

  test("does not let passive browser restoration capture an old-history anchor", () => {
    assert.equal(
      shouldRequestOlderConversationHistory({
        armed: true,
        inLoadZone: true,
        contentUnderfilled: false,
        userDetachedFromLatest: false,
      }),
      false,
    );
  });

  test("loads older history for an intentional reader scroll or an underfilled page", () => {
    assert.equal(
      shouldRequestOlderConversationHistory({
        armed: true,
        inLoadZone: true,
        contentUnderfilled: false,
        userDetachedFromLatest: true,
      }),
      true,
    );
    assert.equal(
      shouldRequestOlderConversationHistory({
        armed: true,
        inLoadZone: true,
        contentUnderfilled: true,
        userDetachedFromLatest: false,
      }),
      true,
    );
  });

  test("maintains a canonical row anchor only for an uninterrupted detached reader", () => {
    assert.equal(
      shouldMaintainDetachedReaderAnchor({
        userDetachedFromLatest: true,
        historyLoadActive: false,
        explicitAlignmentActive: false,
      }),
      true,
    );
    for (const blocked of [
      {
        userDetachedFromLatest: false,
        historyLoadActive: false,
        explicitAlignmentActive: false,
      },
      {
        userDetachedFromLatest: true,
        historyLoadActive: true,
        explicitAlignmentActive: false,
      },
      {
        userDetachedFromLatest: true,
        historyLoadActive: false,
        explicitAlignmentActive: true,
      },
    ]) {
      assert.equal(shouldMaintainDetachedReaderAnchor(blocked), false);
    }
  });
});
