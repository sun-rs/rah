import { useCallback, useEffect, useState } from "react";

export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 20;
export const UI_FONT_SIZE_DEFAULT = 14;
export const CODE_FONT_SIZE_DEFAULT = 12;

const UI_FONT_SIZE_KEY = "rah-ui-font-size";
const APPEARANCE_PREFERENCES_EVENT = "rah:appearance-preferences-updated";

export type AppearanceTypographyPreferences = {
  uiFontSize: number;
  codeFontSize: number;
};

let listenersInitialized = false;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function clampInteger(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function readNumber(
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!isBrowser()) {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return clampInteger(Number.parseFloat(raw), minimum, maximum, fallback);
  } catch {
    return fallback;
  }
}

function writeNumber(key: string, value: number): void {
  if (!isBrowser()) {
    return;
  }
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // A private or storage-constrained browser can still use the live value.
  }
}

export function normalizeUiFontSize(value: number): number {
  return clampInteger(
    value,
    UI_FONT_SIZE_MIN,
    UI_FONT_SIZE_MAX,
    UI_FONT_SIZE_DEFAULT,
  );
}

export function codeFontSizeForConversation(uiFontSize: number): number {
  const normalized = normalizeUiFontSize(uiFontSize);
  return Math.max(11, Math.min(16, normalized - 2));
}

export function readAppearanceTypographyPreferences(): AppearanceTypographyPreferences {
  const uiFontSize = readNumber(
    UI_FONT_SIZE_KEY,
    UI_FONT_SIZE_MIN,
    UI_FONT_SIZE_MAX,
    UI_FONT_SIZE_DEFAULT,
  );
  return {
    uiFontSize,
    codeFontSize: codeFontSizeForConversation(uiFontSize),
  };
}

export function applyAppearanceTypographyPreferences(
  preferences = readAppearanceTypographyPreferences(),
): void {
  if (typeof document === "undefined") {
    return;
  }
  const uiFontSize = normalizeUiFontSize(preferences.uiFontSize);
  const codeFontSize = codeFontSizeForConversation(uiFontSize);
  const root = document.documentElement;
  root.style.setProperty("--rah-ui-font-size", `${uiFontSize}px`);
  root.style.setProperty("--rah-code-font-size", `${codeFontSize}px`);
  root.dataset.rahUiFontSize = String(uiFontSize);
  root.dataset.rahCodeFontSize = String(codeFontSize);
}

function announceAppearancePreferenceChange(): void {
  if (!isBrowser()) {
    return;
  }
  window.dispatchEvent(new Event(APPEARANCE_PREFERENCES_EVENT));
}

export function writeUiFontSizePreference(value: number): number {
  const normalized = normalizeUiFontSize(value);
  writeNumber(UI_FONT_SIZE_KEY, normalized);
  applyAppearanceTypographyPreferences({
    uiFontSize: normalized,
    codeFontSize: codeFontSizeForConversation(normalized),
  });
  announceAppearancePreferenceChange();
  return normalized;
}

export function initializeAppearancePreferences(): void {
  applyAppearanceTypographyPreferences();
  if (listenersInitialized || !isBrowser()) {
    return;
  }
  listenersInitialized = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === UI_FONT_SIZE_KEY) {
      applyAppearanceTypographyPreferences();
    }
  });
}

export function useAppearancePreferences(): AppearanceTypographyPreferences & {
  setUiFontSize: (value: number) => void;
} {
  const [preferences, setPreferences] = useState<AppearanceTypographyPreferences>(
    readAppearanceTypographyPreferences,
  );

  useEffect(() => {
    if (!isBrowser()) {
      return;
    }
    const syncPreferences = () => {
      const next = readAppearanceTypographyPreferences();
      setPreferences(next);
      applyAppearanceTypographyPreferences(next);
    };
    window.addEventListener("storage", syncPreferences);
    window.addEventListener(APPEARANCE_PREFERENCES_EVENT, syncPreferences);
    return () => {
      window.removeEventListener("storage", syncPreferences);
      window.removeEventListener(APPEARANCE_PREFERENCES_EVENT, syncPreferences);
    };
  }, []);

  const setUiFontSize = useCallback((value: number) => {
    const normalized = writeUiFontSizePreference(value);
    setPreferences({
      uiFontSize: normalized,
      codeFontSize: codeFontSizeForConversation(normalized),
    });
  }, []);

  return {
    ...preferences,
    setUiFontSize,
  };
}
