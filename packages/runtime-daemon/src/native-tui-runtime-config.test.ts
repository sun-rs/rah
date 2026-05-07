import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS,
  DEFAULT_NATIVE_TUI_BINDING_WARN_AFTER_MS,
  DEFAULT_NATIVE_TUI_MIRROR_INTERVAL_MS,
  DEFAULT_NATIVE_TUI_MIRROR_WARN_AFTER_MS,
  nativeTuiBindingProbeIntervalMs,
  nativeTuiBindingWarnAfterMs,
  nativeTuiMirrorIntervalMs,
  nativeTuiMirrorWarnAfterMs,
  positiveIntegerEnv,
} from "./native-tui-runtime-config";

describe("native TUI runtime config", () => {
  test("uses defaults when env values are missing", () => {
    assert.equal(
      nativeTuiBindingProbeIntervalMs({}),
      DEFAULT_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS,
    );
    assert.equal(nativeTuiMirrorIntervalMs({}), DEFAULT_NATIVE_TUI_MIRROR_INTERVAL_MS);
    assert.equal(nativeTuiBindingWarnAfterMs({}), DEFAULT_NATIVE_TUI_BINDING_WARN_AFTER_MS);
    assert.equal(nativeTuiMirrorWarnAfterMs({}), DEFAULT_NATIVE_TUI_MIRROR_WARN_AFTER_MS);
  });

  test("accepts positive integer overrides", () => {
    const env = {
      RAH_NATIVE_TUI_BINDING_PROBE_INTERVAL_MS: "250",
      RAH_NATIVE_TUI_MIRROR_INTERVAL_MS: "500",
      RAH_NATIVE_TUI_BINDING_WARN_AFTER_MS: "2500",
      RAH_NATIVE_TUI_MIRROR_WARN_AFTER_MS: "3000",
    };

    assert.equal(nativeTuiBindingProbeIntervalMs(env), 250);
    assert.equal(nativeTuiMirrorIntervalMs(env), 500);
    assert.equal(nativeTuiBindingWarnAfterMs(env), 2500);
    assert.equal(nativeTuiMirrorWarnAfterMs(env), 3000);
  });

  test("falls back for empty, zero, negative, and non-numeric values", () => {
    assert.equal(positiveIntegerEnv({ X: "" }, "X", 42), 42);
    assert.equal(positiveIntegerEnv({ X: "0" }, "X", 42), 42);
    assert.equal(positiveIntegerEnv({ X: "-1" }, "X", 42), 42);
    assert.equal(positiveIntegerEnv({ X: "abc" }, "X", 42), 42);
  });

  test("preserves parseInt-compatible legacy env behavior", () => {
    assert.equal(positiveIntegerEnv({ X: "25ms" }, "X", 42), 25);
    assert.equal(positiveIntegerEnv({ X: "5.5" }, "X", 42), 5);
  });
});
