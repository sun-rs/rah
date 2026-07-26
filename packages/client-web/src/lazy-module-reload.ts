const STALE_LAZY_RELOAD_KEY = "rah:stale-lazy-module-reload-at";
const STALE_LAZY_RELOAD_COOLDOWN_MS = 30_000;
let lastReloadAttemptAt = 0;

export function isLikelyStaleDynamicImportError(error: unknown): boolean {
  const name = (error instanceof Error ? error.name : "").toLowerCase();
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    name === "chunkloaderror" ||
    message.includes("failed to fetch dynamically imported module") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("importing a module script failed") ||
    message.includes("failed to load module script") ||
    message.includes("loading chunk") ||
    message.includes("css_chunk_load_failed")
  );
}

export function shouldReloadForStaleDynamicImport(args: {
  now: number;
  lastReloadAt: number;
  cooldownMs?: number;
}): boolean {
  const cooldownMs = args.cooldownMs ?? STALE_LAZY_RELOAD_COOLDOWN_MS;
  return (
    !Number.isFinite(args.lastReloadAt) ||
    args.lastReloadAt <= 0 ||
    args.now - args.lastReloadAt > cooldownMs
  );
}

function reloadForStaleDynamicImport(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const now = Date.now();
  let persistedReloadAt = 0;
  try {
    persistedReloadAt = Number(
      window.sessionStorage.getItem(STALE_LAZY_RELOAD_KEY) ?? 0,
    );
  } catch {
    // Private browsing and embedded WebViews can deny storage. The in-memory
    // timestamp below still prevents a reload loop for the current document.
  }
  const lastReloadAt = Math.max(lastReloadAttemptAt, persistedReloadAt);
  if (
    !shouldReloadForStaleDynamicImport({
      now,
      lastReloadAt,
    })
  ) {
    return false;
  }
  lastReloadAttemptAt = now;
  try {
    window.sessionStorage.setItem(STALE_LAZY_RELOAD_KEY, String(now));
  } catch {
    // Reload remains useful even when sessionStorage is unavailable.
  }
  window.location.reload();
  return true;
}

/**
 * Vite emits `vite:preloadError` before a failed async chunk escapes into
 * React. Safari/WebKit can instead surface an unhandled rejection with
 * "error loading dynamically imported module". Cover both paths so an open
 * page crosses a web-build generation without showing a crashed pane.
 */
export function installStaleDynamicImportRecovery(): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const handleVitePreloadError = (event: Event) => {
    if (reloadForStaleDynamicImport()) {
      event.preventDefault();
    }
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (
      isLikelyStaleDynamicImportError(event.reason) &&
      reloadForStaleDynamicImport()
    ) {
      event.preventDefault();
    }
  };
  window.addEventListener("vite:preloadError", handleVitePreloadError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  return () => {
    window.removeEventListener("vite:preloadError", handleVitePreloadError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  };
}

export async function importWithStaleReload<T>(importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (error) {
    if (
      isLikelyStaleDynamicImportError(error) &&
      reloadForStaleDynamicImport()
    ) {
      return await new Promise<T>(() => undefined);
    }
    throw error;
  }
}
