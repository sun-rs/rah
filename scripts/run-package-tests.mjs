import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx)$/;

const roots = [];
let concurrency;
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--concurrency=")) {
    concurrency = argument.slice("--concurrency=".length);
    continue;
  }
  roots.push(argument);
}

if (roots.length === 0) {
  throw new Error("At least one test root is required.");
}

async function collectTests(root) {
  const absoluteRoot = path.resolve(root);
  const rootStat = await stat(absoluteRoot);
  if (rootStat.isFile()) {
    return TEST_FILE_PATTERN.test(absoluteRoot) ? [absoluteRoot] : [];
  }
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(absoluteRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTests(absolutePath));
      continue;
    }
    if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

const testFiles = (await Promise.all(roots.map(collectTests))).flat().sort();
if (testFiles.length === 0) {
  throw new Error(`No tests found under: ${roots.join(", ")}`);
}

const parsedConcurrency = concurrency === undefined
  ? Math.min(4, availableParallelism())
  : Number.parseInt(concurrency, 10);
if (!Number.isInteger(parsedConcurrency) || parsedConcurrency < 1) {
  throw new Error(`Invalid test concurrency: ${concurrency}`);
}

async function runTestFile(testFile) {
  const relativeTestFile = path.relative(process.cwd(), testFile);
  console.log(`\n[test-file] ${relativeTestFile}`);
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", "--test-force-exit", testFile],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${relativeTestFile} terminated by ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${relativeTestFile} exited with code ${code ?? "unknown"}.`));
        return;
      }
      resolve();
    });
  });
}

let nextTestIndex = 0;
let firstFailure;
async function runWorker() {
  while (!firstFailure) {
    const testIndex = nextTestIndex;
    nextTestIndex += 1;
    if (testIndex >= testFiles.length) {
      return;
    }
    try {
      await runTestFile(testFiles[testIndex]);
    } catch (error) {
      firstFailure = error;
    }
  }
}

await Promise.all(
  Array.from(
    { length: Math.min(parsedConcurrency, testFiles.length) },
    () => runWorker(),
  ),
);

if (firstFailure) {
  throw firstFailure;
}
