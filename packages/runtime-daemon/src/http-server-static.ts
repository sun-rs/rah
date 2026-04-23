import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCorsHeaders } from "./http-server-cors";
import { writeText } from "./http-server-response";

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
  const body = await tryReadFile(path);
  if (!body) {
    return false;
  }
  applyCorsHeaders(req, res);
  res.writeHead(200, {
    "content-type": contentTypeForPath(path),
    "content-length": body.byteLength,
    "cache-control": options?.cacheControl ?? "no-cache",
  });
  res.end(body);
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
