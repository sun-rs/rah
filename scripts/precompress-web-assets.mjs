import { constants as zlibConstants, brotliCompress, gzip } from "node:zlib";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".webmanifest",
]);
const MIN_SOURCE_BYTES = 1_024;
const MIN_SAVINGS_BYTES = 64;

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(candidate)));
    } else if (entry.isFile()) {
      files.push(candidate);
    }
  }
  return files;
}

async function writeIfSmaller(targetPath, sourceBytes, compressedBytes) {
  if (sourceBytes.byteLength - compressedBytes.byteLength < MIN_SAVINGS_BYTES) {
    return false;
  }
  await writeFile(targetPath, compressedBytes);
  return true;
}

async function precompressFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (
    !COMPRESSIBLE_EXTENSIONS.has(extension) ||
    filePath.endsWith(".br") ||
    filePath.endsWith(".gz")
  ) {
    return { sourceBytes: 0, compressedBytes: 0, variants: 0 };
  }
  const fileStat = await stat(filePath);
  if (fileStat.size < MIN_SOURCE_BYTES) {
    return { sourceBytes: 0, compressedBytes: 0, variants: 0 };
  }
  const source = await readFile(filePath);
  const [brotli, gzipped] = await Promise.all([
    brotliCompressAsync(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
      },
    }),
    gzipAsync(source, { level: zlibConstants.Z_BEST_COMPRESSION }),
  ]);
  const [wroteBrotli, wroteGzip] = await Promise.all([
    writeIfSmaller(`${filePath}.br`, source, brotli),
    writeIfSmaller(`${filePath}.gz`, source, gzipped),
  ]);
  return {
    sourceBytes: source.byteLength,
    compressedBytes:
      (wroteBrotli ? brotli.byteLength : 0) + (wroteGzip ? gzipped.byteLength : 0),
    variants: Number(wroteBrotli) + Number(wroteGzip),
  };
}

const distRoot = path.resolve(
  process.argv[2] ?? path.join(import.meta.dirname, "..", "packages", "client-web", "dist"),
);
const files = await listFiles(distRoot);
const results = await Promise.all(files.map((filePath) => precompressFile(filePath)));
const totals = results.reduce(
  (current, result) => ({
    sourceBytes: current.sourceBytes + result.sourceBytes,
    compressedBytes: current.compressedBytes + result.compressedBytes,
    variants: current.variants + result.variants,
  }),
  { sourceBytes: 0, compressedBytes: 0, variants: 0 },
);

console.log(
  `[rah] precompressed ${totals.variants} web asset variants from ${totals.sourceBytes} source bytes`,
);
