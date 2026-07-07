import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  isCompositionKeyboardEvent,
  shouldSubmitComposerOnEnter,
} from "./composer-keyboard";

type TestKeyboardEvent = {
  key: string;
  shiftKey?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

function keyboardEvent(event: TestKeyboardEvent) {
  return {
    key: event.key,
    shiftKey: event.shiftKey ?? false,
    nativeEvent: {
      isComposing: event.nativeEvent?.isComposing ?? false,
      keyCode: event.nativeEvent?.keyCode ?? 0,
    },
  } as ReactKeyboardEvent<HTMLTextAreaElement>;
}

describe("composer keyboard handling", () => {
  it("detects IME composition keys", () => {
    assert.equal(
      isCompositionKeyboardEvent(keyboardEvent({
        key: "Enter",
        nativeEvent: { isComposing: true },
      })),
      true,
    );
    assert.equal(
      isCompositionKeyboardEvent(keyboardEvent({
        key: "Enter",
        nativeEvent: { keyCode: 229 },
      })),
      true,
    );
  });

  it("allows desktop enter submission outside composition", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        matchMedia: () => ({ matches: false }),
      },
    });
    try {
      assert.equal(shouldSubmitComposerOnEnter(keyboardEvent({ key: "Enter" })), true);
      assert.equal(shouldSubmitComposerOnEnter(keyboardEvent({ key: "Enter", shiftKey: true })), false);
      assert.equal(
        shouldSubmitComposerOnEnter(keyboardEvent({
          key: "Enter",
          nativeEvent: { isComposing: true },
        })),
        false,
      );
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("does not submit touch-keyboard enter", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        matchMedia: () => ({ matches: true }),
      },
    });
    try {
      assert.equal(shouldSubmitComposerOnEnter(keyboardEvent({ key: "Enter" })), false);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
