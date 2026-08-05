import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const root = process.cwd();
const sourceRoots = [
  "packages/runtime-protocol/src",
  "packages/runtime-daemon/src",
  "packages/client-web/src",
];
const entrypoints = [
  "packages/runtime-protocol/src/index.ts",
  "packages/runtime-daemon/src/index.ts",
  "packages/runtime-daemon/src/main.ts",
  "packages/client-web/src/main.tsx",
];
const allowedTestSupport = new Map([
  [
    "packages/runtime-daemon/src/adapter-conformance-test-utils.ts",
    "shared fixture helpers imported only by conformance tests",
  ],
  [
    "packages/runtime-daemon/src/background-ipc-task-test-worker.ts",
    "worker entrypoint launched only by background-ipc-task tests",
  ],
]);

function sourceFilesUnder(relativeRoot) {
  const files = [];
  const visit = (absoluteDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (
        !/\.(?:ts|tsx)$/.test(entry.name) ||
        /\.test\.(?:ts|tsx)$/.test(entry.name) ||
        entry.name.endsWith(".d.ts")
      ) {
        continue;
      }
      files.push(absolutePath);
    }
  };
  visit(path.join(root, relativeRoot));
  return files;
}

function relative(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

const sourceFiles = sourceRoots.flatMap(sourceFilesUnder).map((file) => path.resolve(file));
const sourceFileSet = new Set(sourceFiles);
const dependencyGraph = new Map(sourceFiles.map((file) => [file, new Set()]));

function sourceCandidatePaths(basePath) {
  const extension = path.extname(basePath);
  if (extension === ".js" || extension === ".jsx") {
    const withoutExtension = basePath.slice(0, -extension.length);
    return [`${withoutExtension}.ts`, `${withoutExtension}.tsx`];
  }
  if (extension === ".ts" || extension === ".tsx") {
    return [basePath];
  }
  return [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];
}

function resolveSourceDependency(importer, specifier) {
  if (specifier === "@rah/runtime-protocol") {
    return path.join(root, "packages/runtime-protocol/src/index.ts");
  }
  if (specifier === "@rah/runtime-daemon") {
    return path.join(root, "packages/runtime-daemon/src/index.ts");
  }
  if (!specifier.startsWith(".")) {
    return null;
  }
  const basePath = path.resolve(path.dirname(importer), specifier);
  return sourceCandidatePaths(basePath).find((candidate) => sourceFileSet.has(candidate)) ?? null;
}

function stringLiteralValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8");
  const syntaxKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    syntaxKind,
  );
  const dependencies = dependencyGraph.get(file);

  const remember = (specifier) => {
    const dependency = resolveSourceDependency(file, specifier);
    if (dependency) {
      dependencies.add(dependency);
    }
  };

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const specifier = stringLiteralValue(node.moduleSpecifier);
      if (specifier) remember(specifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const specifier = stringLiteralValue(node.arguments[0]);
      if (specifier) remember(specifier);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length
    ) {
      const specifier = stringLiteralValue(node.arguments[0]);
      if (specifier) remember(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const reachable = new Set();
const pending = entrypoints.map((entrypoint) => path.join(root, entrypoint));
while (pending.length > 0) {
  const file = pending.pop();
  if (!sourceFileSet.has(file) || reachable.has(file)) continue;
  reachable.add(file);
  for (const dependency of dependencyGraph.get(file) ?? []) {
    pending.push(dependency);
  }
}

const missingEntrypoints = entrypoints.filter(
  (entrypoint) => !existsSync(path.join(root, entrypoint)),
);
const staleAllowlist = [...allowedTestSupport.keys()].filter(
  (file) => !existsSync(path.join(root, file)),
);
const unreachable = sourceFiles
  .map(relative)
  .filter((file) => !reachable.has(path.join(root, file)) && !allowedTestSupport.has(file))
  .sort();

if (missingEntrypoints.length > 0 || staleAllowlist.length > 0 || unreachable.length > 0) {
  if (missingEntrypoints.length > 0) {
    console.error("Missing production entrypoints:");
    for (const file of missingEntrypoints) console.error(`  - ${file}`);
  }
  if (staleAllowlist.length > 0) {
    console.error("Stale source-reachability allowlist entries:");
    for (const file of staleAllowlist) console.error(`  - ${file}`);
  }
  if (unreachable.length > 0) {
    console.error("Production source files unreachable from package entrypoints:");
    for (const file of unreachable) console.error(`  - ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Source reachability passed: ${reachable.size}/${sourceFiles.length} production files reachable; ` +
      `${allowedTestSupport.size} explicit test-support entries.`,
  );
}
