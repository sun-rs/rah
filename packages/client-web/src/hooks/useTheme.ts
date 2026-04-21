import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

type ColorScheme = "light" | "dark";

export type AppearancePreference = "system" | "dark" | "light";

const APPEARANCE_KEY = "rah-appearance";

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function safeGetItem(key: string): string | null {
  if (!isBrowser()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function safeRemoveItem(key: string): void {
  if (!isBrowser()) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function parseAppearance(raw: string | null): AppearancePreference {
  if (raw === "dark" || raw === "light") return raw;
  return "system";
}

function getStoredAppearance(): AppearancePreference {
  return parseAppearance(safeGetItem(APPEARANCE_KEY));
}

export function getAppearanceOptions(): ReadonlyArray<{
  value: AppearancePreference;
  label: string;
}> {
  return [
    { value: "system", label: "System" },
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ];
}

function getColorScheme(): ColorScheme {
  const pref = getStoredAppearance();
  if (pref === "dark" || pref === "light") return pref;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function applyTheme(scheme: ColorScheme): void {
  const html = document.documentElement;
  if (scheme === "dark") {
    html.classList.add("dark");
    html.setAttribute("data-theme", "dark");
  } else {
    html.classList.remove("dark");
    html.setAttribute("data-theme", "light");
  }
}

let currentScheme: ColorScheme = getColorScheme();
const listeners = new Set<() => void>();

applyTheme(currentScheme);

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): ColorScheme {
  return currentScheme;
}

function updateScheme(): void {
  const newScheme = getColorScheme();
  if (newScheme !== currentScheme) {
    currentScheme = newScheme;
    applyTheme(newScheme);
    listeners.forEach((cb) => cb());
  }
}

let listenersInitialized = false;

export function useTheme(): { colorScheme: ColorScheme; isDark: boolean } {
  const colorScheme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    colorScheme,
    isDark: colorScheme === "dark",
  };
}

export function useAppearance(): {
  appearance: AppearancePreference;
  setAppearance: (pref: AppearancePreference) => void;
} {
  const [appearance, setAppearanceState] = useState<AppearancePreference>(getStoredAppearance);

  useEffect(() => {
    if (!isBrowser()) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_KEY) return;
      setAppearanceState(parseAppearance(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setAppearance = useCallback((pref: AppearancePreference) => {
    setAppearanceState(pref);
    if (pref === "system") {
      safeRemoveItem(APPEARANCE_KEY);
    } else {
      safeSetItem(APPEARANCE_KEY, pref);
    }
    updateScheme();
  }, []);

  return { appearance, setAppearance };
}

export function initializeTheme(): void {
  currentScheme = getColorScheme();
  applyTheme(currentScheme);

  if (!listenersInitialized) {
    listenersInitialized = true;
    if (typeof window !== "undefined" && window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addEventListener("change", updateScheme);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (event: StorageEvent) => {
        if (event.key === APPEARANCE_KEY) updateScheme();
      });
    }
  }
}
