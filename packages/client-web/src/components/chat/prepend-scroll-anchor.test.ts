import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolvePrependAnchorScrollTop } from "./prepend-scroll-anchor.ts";

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
});
