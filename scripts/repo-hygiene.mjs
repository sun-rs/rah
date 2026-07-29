import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const ignoredWalkDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "test-results",
]);
const forbiddenTrackedSegments = new Set([
  ".nyc_output",
  "coverage",
  "test-results",
]);
const forbiddenFileNames = new Set([".DS_Store"]);
const forbiddenSuffixes = [".bak", ".orig", ".rej", ".tmp"];

function gitTrackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }
  return result.stdout.split("\0").filter(Boolean);
}

function isForbiddenArtifact(relativePath) {
  const segments = relativePath.split("/");
  const baseName = segments.at(-1) ?? relativePath;
  return (
    forbiddenFileNames.has(baseName) ||
    forbiddenSuffixes.some((suffix) => baseName.endsWith(suffix)) ||
    segments.some((segment) => forbiddenTrackedSegments.has(segment))
  );
}

function walkForLocalJunk(directory, relativeDirectory = "") {
  const findings = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      if (ignoredWalkDirectories.has(entry.name)) continue;
      findings.push(
        ...walkForLocalJunk(path.join(directory, entry.name), relativePath),
      );
      continue;
    }
    if (
      forbiddenFileNames.has(entry.name) ||
      forbiddenSuffixes.some((suffix) => entry.name.endsWith(suffix))
    ) {
      findings.push(relativePath);
    }
  }
  return findings;
}

function markdownTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end > 0 ? trimmed.slice(1, end) : null;
  }
  return trimmed.split(/\s+["'(]/, 1)[0] ?? null;
}

function brokenMarkdownLinks(trackedFiles) {
  const findings = [];
  const linkPattern = /!?\[[^\]]*]\(([^)\n]+)\)/g;
  for (const relativePath of trackedFiles) {
    if (!relativePath.endsWith(".md")) continue;
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) continue;
    const source = readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(linkPattern)) {
      const target = markdownTarget(match[1] ?? "");
      if (
        !target ||
        target.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)
      ) {
        continue;
      }
      const withoutAnchor = target.split("#", 1)[0]?.split("?", 1)[0];
      if (!withoutAnchor) continue;
      let decodedTarget;
      try {
        decodedTarget = decodeURIComponent(withoutAnchor);
      } catch {
        decodedTarget = withoutAnchor;
      }
      const resolved = path.resolve(path.dirname(absolutePath), decodedTarget);
      if (!existsSync(resolved)) {
        const line =
          source.slice(0, match.index ?? 0).split("\n").length;
        findings.push(`${relativePath}:${line} -> ${target}`);
      }
    }
  }
  return findings;
}

const trackedFiles = gitTrackedFiles();
const trackedArtifacts = trackedFiles.filter(isForbiddenArtifact);
const localJunk = walkForLocalJunk(root);
const brokenLinks = brokenMarkdownLinks(trackedFiles);

const sections = [
  ["forbidden tracked artifacts", trackedArtifacts],
  ["local editor/OS junk", localJunk],
  ["broken local Markdown links", brokenLinks],
];
let failed = false;
for (const [label, findings] of sections) {
  if (findings.length === 0) continue;
  failed = true;
  console.error(`${label}:`);
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
}
if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    `Repository hygiene passed: ${trackedFiles.length} tracked files, no junk artifacts, local Markdown links resolved.`,
  );
}
