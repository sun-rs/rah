import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  codeFontSizeForConversation,
  normalizeUiFontSize,
  readAppearanceTypographyPreferences,
  writeUiFontSizePreference,
} from "./hooks/useAppearancePreferences";

const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;

function installStorageMock(values = new Map<string, string>()): void {
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
  };
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: storage,
  };
}

afterEach(() => {
  (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  (globalThis as typeof globalThis & { document?: unknown }).document = originalDocument;
});

describe("appearance typography preferences", () => {
  test("uses the Codex Desktop defaults when no preference exists", () => {
    installStorageMock();

    assert.deepEqual(readAppearanceTypographyPreferences(), {
      uiFontSize: 14,
      codeFontSize: 12,
    });
  });

  test("rounds and clamps conversation type to 12–20px and derives readable code type", () => {
    assert.equal(normalizeUiFontSize(10), 12);
    assert.equal(normalizeUiFontSize(14.6), 15);
    assert.equal(normalizeUiFontSize(99), 20);
    assert.equal(codeFontSizeForConversation(12), 11);
    assert.equal(codeFontSizeForConversation(14), 12);
    assert.equal(codeFontSizeForConversation(20), 16);
  });

  test("reads persisted conversation values and ignores the retired independent code setting", () => {
    installStorageMock(
      new Map([
        ["rah-ui-font-size", "20"],
        ["rah-code-font-size", "9.6"],
      ]),
    );

    assert.deepEqual(readAppearanceTypographyPreferences(), {
      uiFontSize: 20,
      codeFontSize: 16,
    });
  });

  test("persists normalized values and applies the matching root CSS tokens", () => {
    const values = new Map<string, string>([["rah-code-font-size", "12"]]);
    const variables = new Map<string, string>();
    const dataset: Record<string, string> = {};
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };
    (globalThis as typeof globalThis & { window?: unknown }).window = {
      localStorage: storage,
      dispatchEvent() {
        return true;
      },
    };
    (globalThis as typeof globalThis & { document?: unknown }).document = {
      documentElement: {
        dataset,
        style: {
          setProperty(key: string, value: string) {
            variables.set(key, value);
          },
        },
      },
    };

    assert.equal(writeUiFontSizePreference(99), 20);
    assert.equal(values.get("rah-ui-font-size"), "20");
    assert.equal(variables.get("--rah-ui-font-size"), "20px");
    assert.equal(dataset.rahUiFontSize, "20");
    assert.equal(variables.get("--rah-code-font-size"), "16px");
    assert.equal(dataset.rahCodeFontSize, "16");
  });
});
