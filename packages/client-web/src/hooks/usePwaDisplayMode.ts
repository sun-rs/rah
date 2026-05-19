import { useEffect, useState } from "react";

const PWA_DISPLAY_MODE_QUERIES = [
  "(display-mode: standalone)",
  "(display-mode: fullscreen)",
  "(display-mode: minimal-ui)",
];

function readPwaDisplayMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return (
    navigatorWithStandalone.standalone === true ||
    PWA_DISPLAY_MODE_QUERIES.some((query) => window.matchMedia(query).matches)
  );
}

export function usePwaDisplayMode(): boolean {
  const [isPwaDisplayMode, setIsPwaDisplayMode] = useState(readPwaDisplayMode);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQueries = PWA_DISPLAY_MODE_QUERIES.map((query) => window.matchMedia(query));
    const update = () => setIsPwaDisplayMode(readPwaDisplayMode());
    for (const mediaQuery of mediaQueries) {
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener("change", update);
      } else {
        mediaQuery.addListener(update);
      }
    }
    update();
    return () => {
      for (const mediaQuery of mediaQueries) {
        if (mediaQuery.removeEventListener) {
          mediaQuery.removeEventListener("change", update);
        } else {
          mediaQuery.removeListener(update);
        }
      }
    };
  }, []);

  return isPwaDisplayMode;
}
