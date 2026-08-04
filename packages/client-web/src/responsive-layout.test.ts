import assert from "node:assert/strict";
import test from "node:test";
import {
  isInlinePanelTier,
  resolveResponsiveTier,
  resolveSidePanelOpenForTier,
  resolveTurnFileOpenSurface,
} from "./responsive-layout";

test("responsive layout has one compact, medium, and wide boundary contract", () => {
  assert.equal(resolveResponsiveTier(390), "compact");
  assert.equal(resolveResponsiveTier(699), "compact");
  assert.equal(resolveResponsiveTier(700), "medium");
  assert.equal(resolveResponsiveTier(899), "medium");
  assert.equal(resolveResponsiveTier(900), "wide");
  assert.equal(isInlinePanelTier("compact"), false);
  assert.equal(isInlinePanelTier("medium"), true);
  assert.equal(isInlinePanelTier("wide"), true);
  assert.equal(isInlinePanelTier("compact", "wide"), false);
  assert.equal(isInlinePanelTier("medium", "wide"), false);
  assert.equal(isInlinePanelTier("wide", "wide"), true);
});

test("reports only the side-panel state used by the current tier", () => {
  assert.equal(resolveSidePanelOpenForTier("compact", true, false), false);
  assert.equal(resolveSidePanelOpenForTier("compact", false, true), true);
  assert.equal(resolveSidePanelOpenForTier("medium", true, false), true);
  assert.equal(resolveSidePanelOpenForTier("medium", false, true), false);
  assert.equal(resolveSidePanelOpenForTier("wide", true, false), true);
  assert.equal(resolveSidePanelOpenForTier("medium", true, false, "wide"), false);
  assert.equal(resolveSidePanelOpenForTier("medium", false, true, "wide"), true);
  assert.equal(resolveSidePanelOpenForTier("wide", true, false, "wide"), true);
});

test("keeps turn-file previews transient when Inspector would be a full-screen overlay", () => {
  assert.equal(resolveTurnFileOpenSurface("compact"), "transient-viewer");
  assert.equal(resolveTurnFileOpenSurface("medium"), "transient-viewer");
  assert.equal(resolveTurnFileOpenSurface("wide"), "inspector");
});
