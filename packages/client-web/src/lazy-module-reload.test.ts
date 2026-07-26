import assert from "node:assert/strict";
import test from "node:test";

import {
  isLikelyStaleDynamicImportError,
  shouldReloadForStaleDynamicImport,
} from "./lazy-module-reload.js";

test("recognizes Chromium, Safari, and WebKit stale dynamic import failures", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: http://127.0.0.1/assets/pane-old.js",
    "error loading dynamically imported module: http://127.0.0.1/assets/pane-old.js",
    "Importing a module script failed.",
    "Failed to load module script: Expected a JavaScript-or-Wasm module script",
  ]) {
    assert.equal(
      isLikelyStaleDynamicImportError(new TypeError(message)),
      true,
      message,
    );
  }
});

test("does not classify ordinary application errors as stale chunks", () => {
  assert.equal(
    isLikelyStaleDynamicImportError(new Error("Cannot read properties of undefined")),
    false,
  );
});

test("reload guard allows one recovery and suppresses immediate loops", () => {
  assert.equal(
    shouldReloadForStaleDynamicImport({
      now: 50_000,
      lastReloadAt: 0,
      cooldownMs: 30_000,
    }),
    true,
  );
  assert.equal(
    shouldReloadForStaleDynamicImport({
      now: 50_000,
      lastReloadAt: 40_000,
      cooldownMs: 30_000,
    }),
    false,
  );
});
