import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RahEvent } from "@rah/runtime-protocol";

const GEMINI_HISTORY_PAGE_SIZE = 256;

export type GeminiHistoryCacheManifest = {
  size: number;
  mtimeMs: number;
  pageSize: number;
  totalEvents: number;
  pageCount: number;
  sourceKind: "json" | "jsonl";
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

function isGeminiHistoryCacheManifest(value: unknown): value is GeminiHistoryCacheManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "size" in value &&
    typeof value.size === "number" &&
    "mtimeMs" in value &&
    typeof value.mtimeMs === "number" &&
    "pageSize" in value &&
    typeof value.pageSize === "number" &&
    "totalEvents" in value &&
    typeof value.totalEvents === "number" &&
    "pageCount" in value &&
    typeof value.pageCount === "number" &&
    "sourceKind" in value &&
    (value.sourceKind === "json" || value.sourceKind === "jsonl")
  );
}

export function readCachedGeminiHistoryManifest(
  filePath: string,
): GeminiHistoryCacheManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(filePath), "utf8")) as unknown;
    return isGeminiHistoryCacheManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadCachedGeminiHistoryManifest(args: {
  filePath: string;
  size: number;
  mtimeMs: number;
}): GeminiHistoryCacheManifest | null {
  const manifest = readCachedGeminiHistoryManifest(args.filePath);
  if (!manifest) {
    return null;
  }
  if (manifest.size !== args.size || manifest.mtimeMs !== args.mtimeMs) {
    return null;
  }
  return manifest;
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
  const manifest = loadCachedGeminiHistoryManifest(args);
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
  const manifest = loadCachedGeminiHistoryManifest(args);
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
  sourceKind: "json" | "jsonl";
}): GeminiHistoryCacheManifest {
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

  const manifest = {
    size: args.size,
    mtimeMs: args.mtimeMs,
    pageSize: GEMINI_HISTORY_PAGE_SIZE,
    totalEvents: args.events.length,
    pageCount,
    sourceKind: args.sourceKind,
  } satisfies GeminiHistoryCacheManifest;
  writeFileSync(manifestPath(args.filePath), JSON.stringify(manifest));
  return manifest;
}

export function appendCachedGeminiHistoryEvents(args: {
  filePath: string;
  previousManifest: GeminiHistoryCacheManifest;
  size: number;
  mtimeMs: number;
  events: RahEvent[];
}): GeminiHistoryCacheManifest {
  const cacheDir = cacheDirPath(args.filePath);
  mkdirSync(cacheDir, { recursive: true });

  let nextPageIndex = args.previousManifest.pageCount;
  let totalEvents = args.previousManifest.totalEvents;
  let remainingEvents = args.events;

  if (args.previousManifest.pageCount > 0) {
    const lastPageIndex = args.previousManifest.pageCount - 1;
    const lastPage = readPageEvents({
      filePath: args.filePath,
      pageIndex: lastPageIndex,
    });
    if (!lastPage) {
      throw new Error("Gemini history cache is missing its last page.");
    }
    const freeSlots = Math.max(0, args.previousManifest.pageSize - lastPage.length);
    if (freeSlots > 0 && remainingEvents.length > 0) {
      const mergedLastPage = [...lastPage, ...remainingEvents.slice(0, freeSlots)];
      writeFileSync(pagePath(args.filePath, lastPageIndex), JSON.stringify(mergedLastPage));
      totalEvents += Math.min(freeSlots, remainingEvents.length);
      remainingEvents = remainingEvents.slice(freeSlots);
    }
  }

  while (remainingEvents.length > 0) {
    const pageEvents = remainingEvents.slice(0, args.previousManifest.pageSize);
    writeFileSync(pagePath(args.filePath, nextPageIndex), JSON.stringify(pageEvents));
    totalEvents += pageEvents.length;
    remainingEvents = remainingEvents.slice(args.previousManifest.pageSize);
    nextPageIndex += 1;
  }

  const manifest = {
    ...args.previousManifest,
    size: args.size,
    mtimeMs: args.mtimeMs,
    totalEvents,
    pageCount: Math.ceil(totalEvents / args.previousManifest.pageSize),
  } satisfies GeminiHistoryCacheManifest;
  writeFileSync(manifestPath(args.filePath), JSON.stringify(manifest));
  return manifest;
}
