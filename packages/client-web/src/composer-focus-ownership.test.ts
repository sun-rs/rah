import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  beginComposerExpansionGesture,
  resolveComposerPointerFocusIntent,
  shouldSuppressComposerControlClickAfterExpansion,
} from "./composer-focus-ownership";

const base = {
  isPwa: true,
  textareaIsActive: true,
  insideComposer: false,
  onTextarea: false,
  onInteractiveControl: false,
  onFocusPreservingPortal: false,
  explicitlyReleasesFocus: false,
};

describe("composer focus ownership", () => {
  test("makes the first collapsed PWA gesture expansion-only", () => {
    const gesture = beginComposerExpansionGesture({
      isPwa: true,
      composerExpanded: false,
      onInteractiveControl: false,
      pointerId: 17,
    });

    assert.deepEqual(gesture, { pointerId: 17 });
    assert.equal(
      shouldSuppressComposerControlClickAfterExpansion({
        gesture,
        onRevealedControl: true,
        pointerGenerated: true,
      }),
      true,
    );
    assert.equal(
      shouldSuppressComposerControlClickAfterExpansion({
        gesture,
        onRevealedControl: false,
        pointerGenerated: true,
      }),
      false,
    );
    assert.equal(
      shouldSuppressComposerControlClickAfterExpansion({
        gesture,
        onRevealedControl: true,
        pointerGenerated: false,
      }),
      false,
      "a stale touch guard must not swallow keyboard activation",
    );
  });

  test("does not guard visible controls or an already expanded composer", () => {
    assert.equal(
      beginComposerExpansionGesture({
        isPwa: true,
        composerExpanded: false,
        onInteractiveControl: true,
        pointerId: 18,
      }),
      null,
    );
    assert.equal(
      beginComposerExpansionGesture({
        isPwa: true,
        composerExpanded: true,
        onInteractiveControl: false,
        pointerId: 19,
      }),
      null,
    );
    assert.equal(
      beginComposerExpansionGesture({
        isPwa: false,
        composerExpanded: false,
        onInteractiveControl: false,
        pointerId: 20,
      }),
      null,
    );
  });

  test("keeps every internal composer control in the active iOS editing session", () => {
    assert.equal(
      resolveComposerPointerFocusIntent({
        ...base,
        insideComposer: true,
        onInteractiveControl: true,
      }),
      "preserve-textarea",
    );
    assert.equal(
      resolveComposerPointerFocusIntent({
        ...base,
        insideComposer: true,
        onInteractiveControl: false,
      }),
      "focus-textarea",
    );
    assert.equal(
      resolveComposerPointerFocusIntent({
        ...base,
        insideComposer: true,
        onTextarea: true,
      }),
      "textarea",
    );
  });

  test("keeps marked portal menus in the same editing session", () => {
    assert.equal(
      resolveComposerPointerFocusIntent({
        ...base,
        onFocusPreservingPortal: true,
      }),
      "preserve-textarea",
    );
  });

  test("only an actual outside pointer or explicit modal release closes PWA editing", () => {
    assert.equal(resolveComposerPointerFocusIntent(base), "outside");
    assert.equal(
      resolveComposerPointerFocusIntent({
        ...base,
        insideComposer: true,
        explicitlyReleasesFocus: true,
      }),
      "release-textarea",
    );
  });

  test("does not steal desktop focus before the textarea editing session starts", () => {
    assert.equal(
      resolveComposerPointerFocusIntent({
        ...base,
        isPwa: false,
        textareaIsActive: false,
        insideComposer: true,
        onInteractiveControl: true,
      }),
      "none",
    );
  });
});
