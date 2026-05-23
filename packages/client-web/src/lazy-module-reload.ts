const STALE_LAZY_RELOAD_KEY = "rah:stale-lazy-module-reload-at";
const STALE_LAZY_RELOAD_COOLDOWN_MS = 30_000;

export function isLikelyStaleDynamicImportError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "ChunkLoadError" ||
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("Loading chunk") ||
    message.includes("CSS_CHUNK_LOAD_FAILED")
  );
}

export async function importWithStaleReload<T>(importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (error) {
    if (isLikelyStaleDynamicImportError(error) && typeof window !== "undefined") {
      const now = Date.now();
      const lastReloadAt = Number(window.sessionStorage.getItem(STALE_LAZY_RELOAD_KEY) ?? 0);
      if (!Number.isFinite(lastReloadAt) || now - lastReloadAt > STALE_LAZY_RELOAD_COOLDOWN_MS) {
        window.sessionStorage.setItem(STALE_LAZY_RELOAD_KEY, String(now));
        window.location.reload();
        return await new Promise<T>(() => undefined);
      }
    }
    throw error;
  }
}
