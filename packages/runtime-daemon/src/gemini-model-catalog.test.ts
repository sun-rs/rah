import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildGeminiModelCatalog, GeminiModelCatalogCache } from "./gemini-model-catalog";

async function createMockGeminiBinary(): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rah-gemini-acp-"));
  const binary = path.join(dir, "gemini-mock.js");
  await writeFile(binary, `#!/usr/bin/env node
const readline = require("node:readline");

if (process.argv.includes("--help")) {
  console.log('--approval-mode Set the approval mode [string] [choices: "default", "auto_edit", "yolo", "plan"]');
  process.exit(0);
}

if (!process.argv.includes("--acp")) {
  process.exit(2);
}

if (process.env.RAH_GEMINI_ACP_FAIL === "1") {
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentInfo: { name: "gemini-cli" } }
    }) + "\\n");
    return;
  }
  if (msg.method === "session/new") {
    const cwd = typeof msg.params?.cwd === "string" ? msg.params.cwd : "";
    const isSecondCwd = cwd.includes("cwd-two");
    const currentModelId = isSecondCwd ? "gemini-second-pro" : "auto-gemini-3";
    const availableModels = isSecondCwd
      ? [
          { modelId: "gemini-second-pro", name: "Gemini Second Pro" },
          { modelId: "gemini-second-flash", name: "Gemini Second Flash" }
        ]
      : [
          { modelId: "auto-gemini-3", name: "Auto (Gemini 3)", description: "Preview auto routing" },
          { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }
        ];
    const writeSessionResponse = () => process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "probe-session",
        models: {
          currentModelId,
          availableModels
        },
        modes: {
          currentModeId: "yolo",
          availableModes: [
            { id: "default", name: "Default", description: "Prompts for approval" },
            { id: "autoEdit", name: "Auto Edit", description: "Auto-approves edits" },
            { id: "yolo", name: "YOLO", description: "Auto-approves all tools" }
          ]
        }
      }
    }) + "\\n");
    const delayMs = Number(process.env.RAH_GEMINI_ACP_SESSION_DELAY_MS || "0");
    if (delayMs > 0) {
      setTimeout(writeSessionResponse, delayMs);
    } else {
      writeSessionResponse();
    }
    return;
  }
});
`);
  await chmod(binary, 0o755);
  return { dir, binary };
}

async function withMockGemini<T>(
  fn: (binary: string, cwd: string) => Promise<T>,
): Promise<T> {
  const previousBinary = process.env.RAH_GEMINI_BINARY;
  const previousFail = process.env.RAH_GEMINI_ACP_FAIL;
  const previousSessionDelay = process.env.RAH_GEMINI_ACP_SESSION_DELAY_MS;
  const { dir, binary } = await createMockGeminiBinary();
  try {
    process.env.RAH_GEMINI_BINARY = binary;
    delete process.env.RAH_GEMINI_ACP_FAIL;
    delete process.env.RAH_GEMINI_ACP_SESSION_DELAY_MS;
    return await fn(binary, dir);
  } finally {
    if (previousBinary === undefined) {
      delete process.env.RAH_GEMINI_BINARY;
    } else {
      process.env.RAH_GEMINI_BINARY = previousBinary;
    }
    if (previousFail === undefined) {
      delete process.env.RAH_GEMINI_ACP_FAIL;
    } else {
      process.env.RAH_GEMINI_ACP_FAIL = previousFail;
    }
    if (previousSessionDelay === undefined) {
      delete process.env.RAH_GEMINI_ACP_SESSION_DELAY_MS;
    } else {
      process.env.RAH_GEMINI_ACP_SESSION_DELAY_MS = previousSessionDelay;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("Gemini catalog prefers ACP models and modes when probe succeeds", async () => {
  await withMockGemini(async (_binary, cwd) => {
    const catalog = await buildGeminiModelCatalog({ cwd, acpProbeTimeoutMs: 1000 });

    assert.equal(catalog.source, "native");
    assert.equal(catalog.sourceDetail, "native_online");
    assert.equal(catalog.freshness, "authoritative");
    assert.equal(catalog.modelsExact, true);
    assert.equal(catalog.optionsExact, true);
    assert.equal(catalog.currentModelId, "auto-gemini-3");
    assert.deepEqual(catalog.models.map((model) => model.id), [
      "auto-gemini-3",
      "gemini-2.5-pro",
    ]);
    assert.deepEqual(catalog.modes?.map((mode) => [mode.id, mode.role]), [
      ["default", "ask"],
      ["autoEdit", "auto_edit"],
      ["yolo", "full_auto"],
    ]);
    assert.deepEqual(catalog.modelProfiles?.map((profile) => profile.source), [
      "native_online",
      "native_online",
    ]);
  });
});

test("Gemini catalog falls back to static models when ACP probe fails", async () => {
  await withMockGemini(async (_binary, cwd) => {
    process.env.RAH_GEMINI_ACP_FAIL = "1";
    const catalog = await buildGeminiModelCatalog({ cwd, acpProbeTimeoutMs: 200 });

    assert.equal(catalog.source, "static");
    assert.equal(catalog.sourceDetail, "static_builtin");
    assert.equal(catalog.freshness, "provisional");
    assert.equal(catalog.modelsExact, false);
    assert.equal(catalog.optionsExact, false);
    assert.equal(catalog.currentModelId, "gemini-3.1-pro-preview");
    assert.equal(catalog.revision, "gemini-static-v2");
    assert.deepEqual(catalog.models.map((model) => model.id), [
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemma-4-31b-it",
      "gemma-4-26b-a4b-it",
    ]);
    assert.deepEqual(catalog.modes?.map((mode) => mode.id), [
      "default",
      "auto_edit",
      "plan",
      "yolo",
    ]);
  });
});

test("Gemini catalog cache returns static first and refreshes ACP in background", async () => {
  await withMockGemini(async (_binary, cwd) => {
    const cache = new GeminiModelCatalogCache();

    const first = await cache.listModels({ cwd });
    assert.equal(first.source, "static");
    assert.equal(first.currentModelId, "gemini-3.1-pro-preview");

    let refreshed = first;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      refreshed = await cache.listModels({ cwd });
      if (refreshed.source === "native") {
        break;
      }
    }

    assert.equal(refreshed.source, "native");
    assert.equal(refreshed.currentModelId, "auto-gemini-3");
    assert.deepEqual(refreshed.models.map((model) => model.id), [
      "auto-gemini-3",
      "gemini-2.5-pro",
    ]);
  });
});

test("Gemini catalog force refresh waits long enough for ACP models", async () => {
  await withMockGemini(async (_binary, cwd) => {
    process.env.RAH_GEMINI_ACP_SESSION_DELAY_MS = "2800";
    const cache = new GeminiModelCatalogCache();

    const catalog = await cache.listModels({ cwd, forceRefresh: true });

    assert.equal(catalog.source, "native");
    assert.equal(catalog.currentModelId, "auto-gemini-3");
  });
});

test("Gemini catalog static fallback does not block a later background refresh", async () => {
  await withMockGemini(async (_binary, cwd) => {
    const cache = new GeminiModelCatalogCache();
    process.env.RAH_GEMINI_ACP_FAIL = "1";

    const fallback = await cache.listModels({ cwd, forceRefresh: true });
    assert.equal(fallback.source, "static");

    delete process.env.RAH_GEMINI_ACP_FAIL;
    let refreshed = fallback;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      refreshed = await cache.listModels({ cwd });
      if (refreshed.source === "native") {
        break;
      }
    }

    assert.equal(refreshed.source, "native");
    assert.equal(refreshed.currentModelId, "auto-gemini-3");
  });
});

test("Gemini catalog cache is isolated by cwd", async () => {
  await withMockGemini(async (_binary, cwd) => {
    const cwdOne = path.join(cwd, "cwd-one");
    const cwdTwo = path.join(cwd, "cwd-two");
    await mkdir(cwdOne);
    await mkdir(cwdTwo);
    const cache = new GeminiModelCatalogCache();

    const first = await cache.listModels({ cwd: cwdOne });
    assert.equal(first.source, "static");

    let refreshedOne = first;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      refreshedOne = await cache.listModels({ cwd: cwdOne });
      if (refreshedOne.source === "native") {
        break;
      }
    }
    assert.equal(refreshedOne.source, "native");
    assert.equal(refreshedOne.currentModelId, "auto-gemini-3");

    const second = await cache.listModels({ cwd: cwdTwo });
    assert.equal(second.source, "static");
    assert.equal(second.currentModelId, "gemini-3.1-pro-preview");

    let refreshedTwo = second;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      refreshedTwo = await cache.listModels({ cwd: cwdTwo });
      if (refreshedTwo.source === "native") {
        break;
      }
    }
    assert.equal(refreshedTwo.source, "native");
    assert.equal(refreshedTwo.currentModelId, "gemini-second-pro");
    assert.deepEqual(refreshedTwo.models.map((model) => model.id), [
      "gemini-second-pro",
      "gemini-second-flash",
    ]);
  });
});
