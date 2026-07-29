import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  assertOptionalWebChunkIsLazy,
  generationAssetFilesFromManifest,
  retainedWebBuildGenerations,
  staleWebAssetFiles,
} from "./web-build-retention.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..");
const clientRoot = path.join(repositoryRoot, "packages", "client-web");
const liveDistRoot = path.join(clientRoot, "dist");
const liveAssetsRoot = path.join(liveDistRoot, "assets");
const generationRegistryPath = path.join(
  liveDistRoot,
  ".rah-web-build-generations.json",
);
const buildLockPath = path.join(clientRoot, ".rah-web-build.lock");
const buildStartedAt = Date.now();
const stagingRoot = path.join(
  clientRoot,
  `.dist-staging-${process.pid}-${buildStartedAt}`,
);
const manifestRelativePath = path.join(".vite", "manifest.json");
const webBuildMetadataRelativePath = ".rah-web-build.json";
const BUILD_LOCK_STALE_MS = 30 * 60 * 1_000;
const webBuildId = randomUUID();

async function listRelativeFiles(root) {
  const files = [];
  async function visit(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  await visit(root, "");
  return files.sort();
}

async function readJson(pathname, fallback) {
  try {
    return JSON.parse(await readFile(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

async function assetsContainText(root, relativeFiles, text) {
  for (const relative of relativeFiles) {
    if (!relative.endsWith(".js")) {
      continue;
    }
    const source = await readFile(path.join(root, relative), "utf8");
    if (source.includes(text)) {
      return true;
    }
  }
  return false;
}

function generationId(assets) {
  return createHash("sha256")
    .update(assets.join("\n"))
    .digest("hex")
    .slice(0, 20);
}

async function snapshotLiveGeneration(now) {
  const availableAssets = await listRelativeFiles(liveAssetsRoot);
  if (availableAssets.length === 0) {
    return null;
  }
  const manifest = await readJson(
    path.join(liveDistRoot, manifestRelativePath),
    null,
  );
  const preciseAssets = manifest
    ? generationAssetFilesFromManifest(manifest, availableAssets)
    : [];
  const assets = preciseAssets.length > 0 ? preciseAssets : availableAssets;
  return {
    id: generationId(assets),
    createdAt: now,
    assets,
  };
}

async function acquireBuildLock() {
  try {
    const lock = await open(buildLockPath, "wx");
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: buildStartedAt }),
      "utf8",
    );
    await lock.close();
    return;
  } catch (error) {
    if (!error || error.code !== "EEXIST") {
      throw error;
    }
  }
  const lockStat = await stat(buildLockPath).catch(() => null);
  if (lockStat && Date.now() - lockStat.mtimeMs > BUILD_LOCK_STALE_MS) {
    await unlink(buildLockPath).catch(() => undefined);
    return acquireBuildLock();
  }
  throw new Error(
    `Another RAH web build is active (${buildLockPath}).`,
  );
}

async function runNodeScript(scriptPath, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${path.basename(scriptPath)} failed (${signal ?? `exit ${code ?? "unknown"}`}).`,
        ),
      );
    });
  });
}

async function atomicCopy(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.rah-next-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicWriteJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.rah-next-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function publishStagedBuild(previousGeneration) {
  const stagedAssetsRoot = path.join(stagingRoot, "assets");
  const stagedAssetFiles = await listRelativeFiles(stagedAssetsRoot);
  const stagedManifest = await readJson(
    path.join(stagingRoot, manifestRelativePath),
    null,
  );
  if (!stagedManifest || stagedAssetFiles.length === 0) {
    throw new Error("Vite build did not produce an asset manifest.");
  }
  const stagedBuildMetadata = await readJson(
    path.join(stagingRoot, webBuildMetadataRelativePath),
    null,
  );
  if (stagedBuildMetadata?.webBuildId !== webBuildId) {
    throw new Error("Vite build metadata does not match the embedded Web generation.");
  }
  if (!(await assetsContainText(stagedAssetsRoot, stagedAssetFiles, webBuildId))) {
    throw new Error("Web generation identifier was not embedded in the built client.");
  }
  assertOptionalWebChunkIsLazy(stagedManifest, "vendor-mermaid");
  const currentAssets = generationAssetFilesFromManifest(
    stagedManifest,
    stagedAssetFiles,
  );
  if (currentAssets.length === 0) {
    throw new Error("Vite manifest does not own any generated assets.");
  }

  for (const relative of stagedAssetFiles) {
    await atomicCopy(
      path.join(stagedAssetsRoot, relative),
      path.join(liveAssetsRoot, relative),
    );
  }

  const stagedRootFiles = await listRelativeFiles(stagingRoot);
  const entryFiles = new Set(["index.html", "index.html.br", "index.html.gz"]);
  for (const relative of stagedRootFiles) {
    if (
      relative.startsWith(`assets${path.sep}`) ||
      entryFiles.has(relative)
    ) {
      continue;
    }
    await atomicCopy(
      path.join(stagingRoot, relative),
      path.join(liveDistRoot, relative),
    );
  }
  for (const relative of ["index.html.br", "index.html.gz"]) {
    if (stagedRootFiles.includes(relative)) {
      await atomicCopy(
        path.join(stagingRoot, relative),
        path.join(liveDistRoot, relative),
      );
    }
  }

  const existingRegistry = await readJson(generationRegistryPath, {
    version: 1,
    generations: [],
  });
  const currentGeneration = {
    id: generationId(currentAssets),
    createdAt: Date.now(),
    assets: currentAssets,
  };
  const generations = retainedWebBuildGenerations([
    ...(Array.isArray(existingRegistry.generations)
      ? existingRegistry.generations
      : []),
    ...(previousGeneration ? [previousGeneration] : []),
    currentGeneration,
  ]);
  await atomicWriteJson(generationRegistryPath, {
    version: 1,
    generations,
  });

  // The HTML entry point is the generation switch. Every asset, manifest and
  // compressed representation it can reference is published before this
  // atomic rename, so readers see either a complete old build or a complete
  // new build.
  await atomicCopy(
    path.join(stagingRoot, "index.html"),
    path.join(liveDistRoot, "index.html"),
  );

  const liveAssetFiles = await listRelativeFiles(liveAssetsRoot);
  const staleAssets = staleWebAssetFiles(liveAssetFiles, generations);
  await Promise.all(
    staleAssets.map((relative) =>
      rm(path.join(liveAssetsRoot, relative), { force: true }),
    ),
  );
  console.log(
    `[rah] published web generation ${currentGeneration.id}; retained ${generations.length} generations and removed ${staleAssets.length} stale assets`,
  );
}

await acquireBuildLock();
try {
  const previousGeneration = await snapshotLiveGeneration(buildStartedAt);
  await rm(stagingRoot, { recursive: true, force: true });
  await build({
    root: clientRoot,
    configFile: path.join(clientRoot, "vite.config.ts"),
    define: {
      __RAH_WEB_BUILD_ID__: JSON.stringify(webBuildId),
    },
    build: {
      outDir: stagingRoot,
      emptyOutDir: true,
      manifest: true,
    },
  });
  await writeFile(
    path.join(stagingRoot, webBuildMetadataRelativePath),
    `${JSON.stringify({
      version: 1,
      webBuildId,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  await runNodeScript(
    path.join(scriptRoot, "precompress-web-assets.mjs"),
    [stagingRoot],
  );
  await publishStagedBuild(previousGeneration);
} finally {
  await rm(stagingRoot, { recursive: true, force: true }).catch(
    () => undefined,
  );
  await unlink(buildLockPath).catch(() => undefined);
}
