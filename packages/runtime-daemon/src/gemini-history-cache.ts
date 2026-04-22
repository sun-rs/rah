import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RahEvent } from "@rah/runtime-protocol";

const GEMINI_HISTORY_PAGE_SIZE = 256;

type GeminiHistoryCacheManifest = {
  size: number;
  mtimeMs: number;
  pageSize: number;
  totalEvents: number;
  pageCount: number;
};

type GeminiHistoryWindow = {
  totalEvents: number;
  events: RahEvent[];
};

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon");
}

function cacheDirPath(filePath: string): string {
  const digest = createHash("sha256").update(filePath).digest("hex");
  return path.join(resolveRahHome(), "gemini-history-cache", digest);
}

function manifestPath(filePath: string): string {
  return path.join(cacheDirPath(filePath), "manifest.json");
}

function pagePath(filePath: string, pageIndex: number): string {
  return path.join(cacheDirPath(filePath), `page-${pageIndex}.json`);
}

function loadCacheManifest(args: {
  filePath: string;
  size: number;
  mtimeMs: number;
}): GeminiHistoryCacheManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(args.filePath), "utf8")) as GeminiHistoryCacheManifest;
    if (
      parsed.size !== args.size ||
      parsed.mtimeMs !== args.mtimeMs ||
      typeof parsed.pageSize !== "number" ||
      typeof parsed.totalEvents !== "number" ||
      typeof parsed.pageCount !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readPageEvents(args: {
  filePath: string;
  pageIndex: number;
}): RahEvent[] | null {
  try {
    const parsed = JSON.parse(readFileSync(pagePath(args.filePath, args.pageIndex), "utf8")) as RahEvent[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadCachedGeminiHistoryEvents(args: {
  filePath: string;
  size: number;
  mtimeMs: number;
}): RahEvent[] | null {
  const manifest = loadCacheManifest(args);
  if (!manifest) {
    return null;
  }
  const pages: RahEvent[] = [];
  for (let pageIndex = 0; pageIndex < manifest.pageCount; pageIndex += 1) {
    const pageEvents = readPageEvents({
      filePath: args.filePath,
      pageIndex,
    });
    if (!pageEvents) {
      return null;
    }
    pages.push(...pageEvents);
  }
  return pages;
}

export function loadCachedGeminiHistoryWindow(args: {
  filePath: string;
  size: number;
  mtimeMs: number;
  startOffset: number;
  endOffset: number;
}): GeminiHistoryWindow | null {
  const manifest = loadCacheManifest(args);
  if (!manifest) {
    return null;
  }
  const boundedStart = Math.max(0, Math.min(args.startOffset, manifest.totalEvents));
  const boundedEnd = Math.max(boundedStart, Math.min(args.endOffset, manifest.totalEvents));
  if (boundedEnd <= boundedStart) {
    return {
      totalEvents: manifest.totalEvents,
      events: [],
    };
  }

  const startPage = Math.floor(boundedStart / manifest.pageSize);
  const endPage = Math.floor((boundedEnd - 1) / manifest.pageSize);
  const pageEvents: RahEvent[] = [];
  for (let pageIndex = startPage; pageIndex <= endPage; pageIndex += 1) {
    const loaded = readPageEvents({
      filePath: args.filePath,
      pageIndex,
    });
    if (!loaded) {
      return null;
    }
    pageEvents.push(...loaded);
  }

  const localStart = boundedStart - startPage * manifest.pageSize;
  const localEnd = localStart + (boundedEnd - boundedStart);
  return {
    totalEvents: manifest.totalEvents,
    events: pageEvents.slice(localStart, localEnd),
  };
}

export function writeCachedGeminiHistoryEvents(args: {
  filePath: string;
  size: number;
  mtimeMs: number;
  events: RahEvent[];
}): void {
  const cacheDir = cacheDirPath(args.filePath);
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });

  const pageCount = Math.ceil(args.events.length / GEMINI_HISTORY_PAGE_SIZE);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageStart = pageIndex * GEMINI_HISTORY_PAGE_SIZE;
    const pageEnd = pageStart + GEMINI_HISTORY_PAGE_SIZE;
    writeFileSync(
      pagePath(args.filePath, pageIndex),
      JSON.stringify(args.events.slice(pageStart, pageEnd)),
    );
  }

  writeFileSync(
    manifestPath(args.filePath),
    JSON.stringify({
      size: args.size,
      mtimeMs: args.mtimeMs,
      pageSize: GEMINI_HISTORY_PAGE_SIZE,
      totalEvents: args.events.length,
      pageCount,
    } satisfies GeminiHistoryCacheManifest),
  );
}
