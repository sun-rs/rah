import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultProductionLineBudget = 1_600;

// Existing large owners are explicit architectural debt. Their ceilings are
// ratchets, not targets: a file may shrink below its ceiling but can never
// grow back to it after the budget is lowered.
const productionDebtBudgets = new Map([
  ["packages/runtime-daemon/src/runtime-engine.ts", 3_774],
  ["packages/runtime-protocol/src/contract.ts", 3_734],
  ["packages/runtime-daemon/src/codex-app-server-activity.ts", 3_641],
  ["packages/client-web/src/App.tsx", 3_610],
  ["packages/runtime-daemon/src/runtime-terminal-coordinator.ts", 2_699],
  ["packages/runtime-daemon/src/codex-rollout-activity.ts", 2_666],
  ["packages/client-web/src/types.ts", 2_496],
  ["packages/client-web/src/council/CouncilPage.tsx", 2_489],
  ["packages/client-web/src/components/chat/ChatThread.tsx", 2_185],
  ["packages/client-web/src/styles.css", 1_989],
  ["packages/client-web/src/useSessionStore.ts", 1_910],
  ["packages/runtime-daemon/src/opencode-stored-sessions.ts", 1_903],
]);

const packageSourceRoots = [
  "packages/runtime-protocol/src",
  "packages/runtime-daemon/src",
  "packages/client-web/src",
];

function isProductionSource(relativePath) {
  return (
    /\.(?:ts|tsx|css)$/.test(relativePath) &&
    !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relativePath) &&
    !relativePath.endsWith(".d.ts")
  );
}

async function listProductionSources() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(
    "rg",
    ["--files", ...packageSourceRoots],
    { cwd: rootDir, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter(isProductionSource)
    .sort();
}

function physicalLineCount(source) {
  if (!source) return 0;
  return source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
}

const failures = [];
const productionSources = await listProductionSources();
const observed = new Map();

for (const relativePath of productionSources) {
  const source = await readFile(path.join(rootDir, relativePath), "utf8");
  const lines = physicalLineCount(source);
  observed.set(relativePath, { source, lines });
  const budget = productionDebtBudgets.get(relativePath) ?? defaultProductionLineBudget;
  if (lines > budget) {
    failures.push(`${relativePath}: ${lines} lines exceeds its ${budget}-line budget`);
  }
}

for (const [relativePath] of productionDebtBudgets) {
  if (!observed.has(relativePath)) {
    failures.push(`${relativePath}: stale architecture-debt entry; lower or remove its budget`);
  }
}

const appSource = observed.get("packages/client-web/src/App.tsx")?.source ?? "";
for (const requiredImport of [
  'from "./app-lazy-components"',
  'from "./new-session-drafts"',
  'from "./hooks/useForegroundSessionRecovery"',
]) {
  if (!appSource.includes(requiredImport)) {
    failures.push(`App.tsx must retain extracted owner ${requiredImport}`);
  }
}
for (const forbiddenOwner of [
  "MODEL_DRAFT_STORAGE_KEY",
  "runForegroundRecoveryLoop",
  "class FilePreviewDialogErrorBoundary",
]) {
  if (appSource.includes(forbiddenOwner)) {
    failures.push(`App.tsx reabsorbed extracted owner: ${forbiddenOwner}`);
  }
}

const runtimeEngineSource = observed.get(
  "packages/runtime-daemon/src/runtime-engine.ts",
)?.source ?? "";
if (!runtimeEngineSource.includes('from "./runtime-workspace-operations"')) {
  failures.push("runtime-engine.ts must delegate workspace operations to their owner");
}
if (runtimeEngineSource.includes('from "./workspace-utils"')) {
  failures.push("runtime-engine.ts must not reabsorb low-level workspace operations");
}

if (failures.length > 0) {
  console.error("Source architecture check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Source architecture passed: ${productionSources.length} production files; ` +
      `${productionDebtBudgets.size} ratcheted debt files; ` +
      `${defaultProductionLineBudget}-line default ceiling.`,
  );
}
