import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { readShowModelInfoPreference, writeShowModelInfoPreference } from "./hooks/useChatPreferences";

const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
const originalLocalStorage = (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;

function installStorageMock(values = new Map<string, string>()): Map<string, string> {
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
  (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage = storage;
  (globalThis as typeof globalThis & { window?: unknown }).window = { localStorage: storage };
  return values;
}

afterEach(() => {
  (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage = originalLocalStorage;
  (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
});

describe("chat preferences", () => {
  test("shows model info by default", () => {
    installStorageMock();

    assert.equal(readShowModelInfoPreference(), true);
  });

  test("stores one global model info preference and clears legacy provider keys", () => {
    const values = installStorageMock(
      new Map([
        ["rah-show-model-info-in-chat:codex", "false"],
        ["rah-show-model-info-in-chat:claude", "true"],
      ]),
    );

    writeShowModelInfoPreference(false);

    assert.equal(values.get("rah-show-model-info-in-chat"), "false");
    assert.equal(values.has("rah-show-model-info-in-chat:codex"), false);
    assert.equal(values.has("rah-show-model-info-in-chat:claude"), false);
    assert.equal(readShowModelInfoPreference(), false);
  });
});
