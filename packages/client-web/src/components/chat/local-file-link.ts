const LOCAL_ABSOLUTE_PATH_PREFIXES = [
  "/Users/",
  "/home/",
  "/workspace/",
  "/tmp/",
  "/private/",
  "/Volumes/",
];

function decodePathname(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripQueryAndHash(value: string): string {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  return indexes.length === 0 ? value : value.slice(0, Math.min(...indexes));
}

function isLikelyLocalAbsolutePath(pathname: string): boolean {
  return LOCAL_ABSOLUTE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isLocalhostUrl(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

export function resolveLocalFileLinkPath(href: string | undefined): string | null {
  const rawHref = href?.trim();
  if (!rawHref) {
    return null;
  }

  if (rawHref.startsWith("file://")) {
    try {
      const url = new URL(rawHref);
      const pathname = decodePathname(url.pathname);
      return isLikelyLocalAbsolutePath(pathname) ? pathname : null;
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(rawHref)) {
    try {
      const url = new URL(rawHref);
      const currentOrigin =
        typeof window !== "undefined" ? window.location.origin : undefined;
      const sameRahOrigin = currentOrigin ? url.origin === currentOrigin : false;
      if (!sameRahOrigin && !isLocalhostUrl(url)) {
        return null;
      }
      const pathname = decodePathname(url.pathname);
      return isLikelyLocalAbsolutePath(pathname) ? pathname : null;
    } catch {
      return null;
    }
  }

  if (!rawHref.startsWith("/") || rawHref.startsWith("//")) {
    return null;
  }

  const pathname = decodePathname(stripQueryAndHash(rawHref));
  return isLikelyLocalAbsolutePath(pathname) ? pathname : null;
}
