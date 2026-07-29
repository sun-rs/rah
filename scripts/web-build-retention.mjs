import path from "node:path";

export const DEFAULT_WEB_ASSET_GRACE_PERIOD_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_WEB_ASSET_MINIMUM_GENERATIONS = 3;

function assetFileFromOutputPath(value) {
  if (typeof value !== "string" || !value.startsWith("assets/")) {
    return null;
  }
  const relative = path.posix.normalize(value.slice("assets/".length));
  if (
    !relative ||
    relative === "." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

export function collectManifestAssetFiles(manifest) {
  const assets = new Set();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return assets;
  }
  for (const chunk of Object.values(manifest)) {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      continue;
    }
    const candidates = [
      chunk.file,
      ...(Array.isArray(chunk.css) ? chunk.css : []),
      ...(Array.isArray(chunk.assets) ? chunk.assets : []),
    ];
    for (const candidate of candidates) {
      const asset = assetFileFromOutputPath(candidate);
      if (asset) {
        assets.add(asset);
      }
    }
  }
  return assets;
}

export function generationAssetFilesFromManifest(
  manifest,
  availableAssetFiles,
) {
  const available = new Set(availableAssetFiles);
  const generationAssets = new Set();
  for (const asset of collectManifestAssetFiles(manifest)) {
    for (const candidate of [asset, `${asset}.br`, `${asset}.gz`]) {
      if (available.has(candidate)) {
        generationAssets.add(candidate);
      }
    }
  }
  return [...generationAssets].sort();
}

export function assertOptionalWebChunkIsLazy(manifest, chunkName) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Vite manifest is unavailable.");
  }
  const entries = Object.values(manifest).filter(
    (chunk) =>
      chunk &&
      typeof chunk === "object" &&
      !Array.isArray(chunk) &&
      chunk.isEntry === true,
  );
  const optionalChunks = Object.entries(manifest).filter(
    ([, chunk]) =>
      chunk &&
      typeof chunk === "object" &&
      !Array.isArray(chunk) &&
      chunk.name === chunkName,
  );
  if (optionalChunks.length === 0) {
    throw new Error(`Optional web chunk ${chunkName} was not emitted.`);
  }
  const optionalKeys = new Set(optionalChunks.map(([key]) => key));
  for (const entry of entries) {
    const eagerOptionalImport = (entry.imports ?? []).find((key) =>
      optionalKeys.has(key),
    );
    if (eagerOptionalImport) {
      throw new Error(
        `Optional web chunk ${chunkName} became an eager dependency of ${entry.file}.`,
      );
    }
  }
  if (
    !optionalChunks.some(
      ([, chunk]) => chunk.isDynamicEntry === true,
    )
  ) {
    throw new Error(`Optional web chunk ${chunkName} is not a dynamic entry.`);
  }
}

export function retainedWebBuildGenerations(
  generations,
  options = {},
) {
  const now = options.now ?? Date.now();
  const minimumGenerations =
    options.minimumGenerations ?? DEFAULT_WEB_ASSET_MINIMUM_GENERATIONS;
  const gracePeriodMs =
    options.gracePeriodMs ?? DEFAULT_WEB_ASSET_GRACE_PERIOD_MS;
  const unique = new Map();
  for (const generation of generations) {
    if (
      !generation ||
      typeof generation.id !== "string" ||
      !Number.isFinite(generation.createdAt) ||
      !Array.isArray(generation.assets)
    ) {
      continue;
    }
    const normalized = {
      id: generation.id,
      createdAt: generation.createdAt,
      assets: [...new Set(generation.assets.filter((asset) => typeof asset === "string"))]
        .sort(),
    };
    const previous = unique.get(normalized.id);
    if (!previous || previous.createdAt <= normalized.createdAt) {
      unique.set(normalized.id, normalized);
    }
  }
  const ordered = [...unique.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const minimumStart = Math.max(0, ordered.length - Math.max(1, minimumGenerations));
  return ordered.filter(
    (generation, index) =>
      index >= minimumStart ||
      now - generation.createdAt <= gracePeriodMs,
  );
}

export function staleWebAssetFiles(
  availableAssetFiles,
  retainedGenerations,
) {
  const protectedAssets = new Set(
    retainedGenerations.flatMap((generation) => generation.assets),
  );
  return availableAssetFiles
    .filter((asset) => !protectedAssets.has(asset))
    .sort();
}
