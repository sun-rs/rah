import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  computeKeyboardInsetPx,
  computeTerminalVisibleHeightPx,
  readTerminalViewportMetrics,
} from "./terminal-viewport";

describe("terminal viewport metrics", () => {
  test("computes keyboard inset from visual viewport shrinkage", () => {
    assert.equal(
      computeKeyboardInsetPx({
        layoutHeight: 844,
        visualHeight: 512,
        visualOffsetTop: 0,
      }),
      332,
    );
    assert.equal(
      computeKeyboardInsetPx({
        layoutHeight: 844,
        visualHeight: 844,
        visualOffsetTop: 0,
      }),
      0,
    );
  });

  test("shrinks terminal height to the visible viewport without growing small panes", () => {
    assert.equal(
      computeTerminalVisibleHeightPx({
        panelTop: 96,
        panelHeight: 700,
        visualHeight: 520,
        visualOffsetTop: 0,
      }),
      424,
    );
    assert.equal(
      computeTerminalVisibleHeightPx({
        panelTop: 96,
        panelHeight: 120,
        visualHeight: 520,
        visualOffsetTop: 0,
      }),
      120,
    );
  });

  test("accounts for shifted visual viewport top on iOS browser chrome transitions", () => {
    assert.equal(
      computeTerminalVisibleHeightPx({
        panelTop: 20,
        panelHeight: 700,
        visualHeight: 500,
        visualOffsetTop: 64,
      }),
      500,
    );
  });

  test("returns panel anchor metrics for fixed keyboard layout", () => {
    const previousWindow = globalThis.window;
    const fakeWindow = {
      innerHeight: 844,
      visualViewport: {
        height: 500,
        offsetTop: 64,
      },
    } as unknown as Window & typeof globalThis;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
    });
    try {
      const metrics = readTerminalViewportMetrics({
        getBoundingClientRect: () =>
          ({
            top: 32,
            left: 18.4,
            width: 390.2,
            height: 720,
          }) as DOMRect,
      } as HTMLElement);
      assert.equal(metrics.keyboardInsetPx, 280);
      assert.equal(metrics.visibleHeightPx, 500);
      assert.equal(metrics.panelTopPx, 64);
      assert.equal(metrics.panelLeftPx, 18);
      assert.equal(metrics.panelWidthPx, 390);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  });
});
