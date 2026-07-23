import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCorsHeaders } from "./http-server-cors";
import { writeText } from "./http-server-response";

type StaticContentEncoding = "br" | "gzip";

const CLIENT_DIST_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "client-web",
  "dist",
);
const CLIENT_INDEX_PATH = resolve(CLIENT_DIST_ROOT, "index.html");

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

function contentTypeForPath(path: string): string {
  return CONTENT_TYPE_BY_EXTENSION[extname(path)] ?? "application/octet-stream";
}

async function tryReadFile(path: string): Promise<Buffer | null> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return null;
    }
    return await readFile(path);
  } catch {
    return null;
  }
}

function parseEncodingPreference(
  header: string,
): Map<string, number> {
  const preferences = new Map<string, number>();
  for (const rawEntry of header.split(",")) {
    const [rawCoding, ...rawParameters] = rawEntry.trim().toLowerCase().split(";");
    const coding = rawCoding?.trim();
    if (!coding) {
      continue;
    }
    let quality = 1;
    for (const rawParameter of rawParameters) {
      const match = /^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(rawParameter.trim());
      if (match?.[1]) {
        quality = Number.parseFloat(match[1]);
      }
    }
    preferences.set(coding, Math.max(preferences.get(coding) ?? 0, quality));
  }
  return preferences;
}

function acceptedStaticContentEncodings(
  acceptEncoding: string | string[] | undefined,
): StaticContentEncoding[] {
  if (typeof acceptEncoding !== "string") {
    return [];
  }
  const preferences = parseEncodingPreference(acceptEncoding);
  const wildcardQuality = preferences.get("*") ?? 0;
  const brotliQuality = preferences.get("br") ?? wildcardQuality;
  const gzipQuality = preferences.get("gzip") ?? wildcardQuality;
  return [
    { encoding: "br" as const, quality: brotliQuality },
    { encoding: "gzip" as const, quality: gzipQuality },
  ]
    .filter((entry) => entry.quality > 0)
    .sort(
      (left, right) =>
        right.quality - left.quality ||
        (left.encoding === "br" ? -1 : 1),
    )
    .map((entry) => entry.encoding);
}

export function preferredStaticContentEncoding(
  acceptEncoding: string | string[] | undefined,
): StaticContentEncoding | null {
  return acceptedStaticContentEncodings(acceptEncoding)[0] ?? null;
}

async function readStaticRepresentation(
  path: string,
  acceptEncoding: string | string[] | undefined,
): Promise<{ body: Buffer; encoding?: StaticContentEncoding } | null> {
  for (const encoding of acceptedStaticContentEncodings(acceptEncoding)) {
    const body = await tryReadFile(`${path}.${encoding === "gzip" ? "gz" : "br"}`);
    if (body) {
      return { body, encoding };
    }
  }
  const body = await tryReadFile(path);
  return body ? { body } : null;
}

function resolveClientAssetPath(pathname: string): string | null {
  const cleaned = pathname == "/" ? "/index.html" : pathname;
  const candidate = resolve(CLIENT_DIST_ROOT, cleaned.replace(/^\/+/, ""));
  const rel = relative(CLIENT_DIST_ROOT, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return candidate;
}

async function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  options?: { cacheControl?: string },
): Promise<boolean> {
  const representation = await readStaticRepresentation(path, req.headers["accept-encoding"]);
  if (!representation) {
    return false;
  }
  applyCorsHeaders(req, res);
  res.writeHead(200, {
    "content-type": contentTypeForPath(path),
    "content-length": representation.body.byteLength,
    "cache-control": options?.cacheControl ?? "no-cache",
    ...(representation.encoding
      ? {
          "content-encoding": representation.encoding,
          vary: "accept-encoding",
        }
      : {}),
  });
  res.end(representation.body);
  return true;
}

export async function serveClientApp(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const assetPath = resolveClientAssetPath(pathname);
  if (assetPath) {
    const cacheControl =
      pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    if (await serveStaticFile(req, res, assetPath, { cacheControl })) {
      return true;
    }
  }

  const expectsHtml = pathname === "/" || extname(pathname) === "";
  if (!expectsHtml) {
    return false;
  }

  if (await serveStaticFile(req, res, CLIENT_INDEX_PATH)) {
    return true;
  }

  writeText(
    req,
    res,
    503,
    "RAH client bundle not found. Run `npm --prefix packages/client-web run build` first.",
  );
  return true;
}
