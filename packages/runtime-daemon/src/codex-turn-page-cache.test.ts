import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CodexAppServerTurnsPage } from "./codex-app-server-turns-page";
import { CodexTurnPageCache } from "./codex-turn-page-cache";

function page(id: string): CodexAppServerTurnsPage {
  return { data: [{ id, status: "completed", items: [] }] };
}

test("Codex turn page cache coalesces requests and survives a new cache instance", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-codex-page-cache-"));
  const rolloutPath = path.join(root, "rollout.jsonl");
  const cacheRoot = path.join(root, "cache");
  writeFileSync(rolloutPath, "first\n", "utf8");
  let loads = 0;
  const cache = new CodexTurnPageCache({ rootDir: cacheRoot });
  const request = {
    providerSessionId: "provider-session",
    rolloutPath,
    cursor: "older",
    limit: 20,
    sourceSettled: true,
    load: async () => {
      loads += 1;
      await Promise.resolve();
      return page("turn-one");
    },
  };

  const [first, concurrent] = await Promise.all([
    cache.getOrLoad(request),
    cache.getOrLoad(request),
  ]);
  assert.equal(loads, 1);
  assert.deepEqual(first, page("turn-one"));
  assert.deepEqual(concurrent, page("turn-one"));
  assert.deepEqual(await cache.getOrLoad(request), page("turn-one"));
  assert.equal(loads, 1);

  const freshCache = new CodexTurnPageCache({ rootDir: cacheRoot });
  const fromDisk = await freshCache.getOrLoad({
    ...request,
    load: async () => {
      throw new Error("persistent cache miss");
    },
  });
  assert.deepEqual(fromDisk, page("turn-one"));
  rmSync(root, { recursive: true, force: true });
});

test("Codex newest turn page cache invalidates on rollout growth and explicit clear", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rah-codex-page-cache-revision-"),
  );
  const rolloutPath = path.join(root, "rollout.jsonl");
  writeFileSync(rolloutPath, "first\n", "utf8");
  let loads = 0;
  const cache = new CodexTurnPageCache({ rootDir: path.join(root, "cache") });
  const load = async () => page(`turn-${++loads}`);
  const request = {
    providerSessionId: "provider-session",
    rolloutPath,
    limit: 20,
    sourceSettled: false,
    load,
  };

  assert.deepEqual(await cache.getOrLoad(request), page("turn-1"));
  writeFileSync(rolloutPath, "second\n", { encoding: "utf8", flag: "a" });
  assert.deepEqual(await cache.getOrLoad(request), page("turn-2"));
  cache.clear("provider-session");
  assert.deepEqual(await cache.getOrLoad(request), page("turn-3"));
  assert.equal(loads, 3);
  rmSync(root, { recursive: true, force: true });
});

test("Codex historical turn page cache survives append-only growth", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rah-codex-page-cache-append-"),
  );
  const rolloutPath = path.join(root, "rollout.jsonl");
  const cacheRoot = path.join(root, "cache");
  writeFileSync(rolloutPath, "first historical boundary\n", "utf8");
  let loads = 0;
  const request = {
    providerSessionId: "provider-session",
    rolloutPath,
    cursor: "older",
    limit: 20,
    sourceSettled: false,
    load: async () => page(`turn-${++loads}`),
  };
  const cache = new CodexTurnPageCache({ rootDir: cacheRoot });

  assert.deepEqual(await cache.getOrLoad(request), page("turn-1"));
  writeFileSync(rolloutPath, "appended live output\n", {
    encoding: "utf8",
    flag: "a",
  });
  assert.deepEqual(await cache.getOrLoad(request), page("turn-1"));

  const freshCache = new CodexTurnPageCache({ rootDir: cacheRoot });
  assert.deepEqual(await freshCache.getOrLoad(request), page("turn-1"));
  assert.equal(loads, 1);
  rmSync(root, { recursive: true, force: true });
});

test("Codex historical turn page cache rejects in-place rewrites and clear", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "rah-codex-page-cache-rewrite-"),
  );
  const rolloutPath = path.join(root, "rollout.jsonl");
  writeFileSync(rolloutPath, "original historical boundary\n", "utf8");
  let loads = 0;
  const cache = new CodexTurnPageCache({ rootDir: path.join(root, "cache") });
  const request = {
    providerSessionId: "provider-session",
    rolloutPath,
    cursor: "older",
    limit: 20,
    sourceSettled: false,
    load: async () => page(`turn-${++loads}`),
  };

  assert.deepEqual(await cache.getOrLoad(request), page("turn-1"));
  writeFileSync(
    rolloutPath,
    "rewritten historical boundary with a different body\n",
    "utf8",
  );
  assert.deepEqual(await cache.getOrLoad(request), page("turn-2"));
  cache.clear("provider-session");
  assert.deepEqual(await cache.getOrLoad(request), page("turn-3"));
  assert.equal(loads, 3);
  rmSync(root, { recursive: true, force: true });
});
