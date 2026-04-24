import { spawn } from "node:child_process";
import type { ProviderDiagnostic, ProviderKind } from "@rah/runtime-protocol";
import { resolveConfiguredBinary } from "./provider-binary-utils";

type LaunchSpec = {
  argv: string[];
};

type LatestVersionResult = {
  latestVersion?: string;
  latestVersionSource?: ProviderDiagnostic["latestVersionSource"];
  latestVersionError?: string;
};

const LATEST_VERSION_CACHE_TTL_MS = 30 * 60 * 1_000;

const latestVersionCache = new Map<
  ProviderKind,
  { expiresAt: number; value: LatestVersionResult }
>();
const latestVersionInFlight = new Map<ProviderKind, Promise<LatestVersionResult>>();

const VERSION_PATTERN = /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;

export async function codexLaunchSpec(): Promise<LaunchSpec> {
  return {
    argv: [await resolveConfiguredBinary("RAH_CODEX_BINARY", "codex")],
  };
}

export async function claudeLaunchSpec(): Promise<LaunchSpec> {
  return {
    argv: [await resolveConfiguredBinary("RAH_CLAUDE_BINARY", "claude")],
  };
}

export async function geminiLaunchSpec(): Promise<LaunchSpec> {
  return {
    argv: [await resolveConfiguredBinary("RAH_GEMINI_BINARY", "gemini")],
  };
}

export async function kimiLaunchSpec(): Promise<LaunchSpec> {
  if (process.env.RAH_KIMI_BINARY) {
    return { argv: [await resolveConfiguredBinary("RAH_KIMI_BINARY", "kimi")] };
  }
  if (process.env.RAH_KIMI_PROJECT) {
    return {
      argv: ["uv", "run", "--project", process.env.RAH_KIMI_PROJECT, "kimi"],
    };
  }
  return {
    argv: ["kimi"],
  };
}

export async function opencodeLaunchSpec(): Promise<LaunchSpec> {
  return {
    argv: [await resolveConfiguredBinary("RAH_OPENCODE_BINARY", "opencode")],
  };
}

export async function launchSpecForProvider(provider: ProviderKind): Promise<LaunchSpec | null> {
  switch (provider) {
    case "codex":
      return await codexLaunchSpec();
    case "claude":
      return await claudeLaunchSpec();
    case "gemini":
      return await geminiLaunchSpec();
    case "kimi":
      return await kimiLaunchSpec();
    case "opencode":
      return await opencodeLaunchSpec();
    default:
      return null;
  }
}

export function extractVersionString(rawOutput: string | undefined): string | undefined {
  if (!rawOutput) {
    return undefined;
  }
  const match = rawOutput.trim().match(VERSION_PATTERN);
  return match ? normalizeVersion(match[0]) : undefined;
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | null;

function parseVersion(version: string | undefined): ParsedVersion {
  if (!version) {
    return null;
  }
  const normalized = normalizeVersion(version);
  const match =
    normalized.match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (!a.length && !b.length) {
    return 0;
  }
  if (!a.length) {
    return 1;
  }
  if (!b.length) {
    return -1;
  }
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? 1 : -1;
      }
      continue;
    }
    if (leftNumber !== null) {
      return -1;
    }
    if (rightNumber !== null) {
      return 1;
    }
    if (left !== right) {
      return left > right ? 1 : -1;
    }
  }
  return 0;
}

export function compareVersions(
  installedVersion: string | undefined,
  latestVersion: string | undefined,
): ProviderDiagnostic["versionStatus"] {
  const installed = parseVersion(installedVersion);
  const latest = parseVersion(latestVersion);
  if (!installed || !latest) {
    return "unknown";
  }
  if (installed.major !== latest.major) {
    return installed.major >= latest.major ? "up_to_date" : "update_available";
  }
  if (installed.minor !== latest.minor) {
    return installed.minor >= latest.minor ? "up_to_date" : "update_available";
  }
  if (installed.patch !== latest.patch) {
    return installed.patch >= latest.patch ? "up_to_date" : "update_available";
  }
  return comparePrerelease(installed.prerelease, latest.prerelease) >= 0
    ? "up_to_date"
    : "update_available";
}

export function resetProviderDiagnosticsCacheForTests(): void {
  latestVersionCache.clear();
  latestVersionInFlight.clear();
}

function buildProviderDiagnostic(params: {
  provider: ProviderKind;
  status: ProviderDiagnostic["status"];
  launchCommand: string;
  latest: LatestVersionResult;
  installedVersion?: string;
  versionStatus?: ProviderDiagnostic["versionStatus"];
  detail?: string;
}): ProviderDiagnostic {
  const diagnostic: ProviderDiagnostic = {
    provider: params.provider,
    status: params.status,
    launchCommand: params.launchCommand,
    auth: "provider_managed",
  };
  if (params.installedVersion) {
    diagnostic.installedVersion = params.installedVersion;
  }
  if (params.latest.latestVersion) {
    diagnostic.latestVersion = params.latest.latestVersion;
  }
  if (params.latest.latestVersionSource) {
    diagnostic.latestVersionSource = params.latest.latestVersionSource;
  }
  if (params.latest.latestVersionError) {
    diagnostic.latestVersionError = params.latest.latestVersionError;
  }
  if (params.versionStatus) {
    diagnostic.versionStatus = params.versionStatus;
  }
  if (params.detail) {
    diagnostic.detail = params.detail;
  }
  return diagnostic;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "rah-workbench/1.0",
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "rah-workbench/1.0",
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return (await response.text()).trim();
}

async function fetchLatestVersion(
  provider: ProviderKind,
): Promise<LatestVersionResult> {
  switch (provider) {
    case "claude": {
      const payload = await fetchJson<{ version?: string }>(
        "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
      );
      const latestVersion = payload.version ? normalizeVersion(payload.version) : undefined;
      return {
        ...(latestVersion ? { latestVersion } : {}),
        latestVersionSource: "npm",
      };
    }
    case "codex": {
      const payload = await fetchJson<{ tag_name?: string }>(
        "https://api.github.com/repos/openai/codex/releases/latest",
      );
      const latestVersion = extractVersionString(payload.tag_name);
      return {
        ...(latestVersion ? { latestVersion } : {}),
        latestVersionSource: "github",
      };
    }
    case "gemini": {
      const payload = await fetchJson<{ version?: string }>(
        "https://registry.npmjs.org/@google/gemini-cli/latest",
      );
      const latestVersion = payload.version ? normalizeVersion(payload.version) : undefined;
      return {
        ...(latestVersion ? { latestVersion } : {}),
        latestVersionSource: "npm",
      };
    }
    case "kimi": {
      const payload = await fetchText("https://cdn.kimi.com/binaries/kimi-cli/latest");
      const latestVersion = extractVersionString(payload);
      return {
        ...(latestVersion ? { latestVersion } : {}),
        latestVersionSource: "cdn",
      };
    }
    case "opencode": {
      const payload = await fetchJson<{ tag_name?: string }>(
        "https://api.github.com/repos/sst/opencode/releases/latest",
      );
      const latestVersion = extractVersionString(payload.tag_name);
      return {
        ...(latestVersion ? { latestVersion } : {}),
        latestVersionSource: "github",
      };
    }
    default:
      return {};
  }
}

async function getLatestVersionResult(
  provider: ProviderKind,
  options?: {
    forceRefresh?: boolean;
  },
): Promise<LatestVersionResult> {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();
  if (forceRefresh) {
    latestVersionCache.delete(provider);
  }
  const cached = forceRefresh ? undefined : latestVersionCache.get(provider);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const current = forceRefresh ? undefined : latestVersionInFlight.get(provider);
  if (current) {
    return current;
  }
  const request = fetchLatestVersion(provider)
    .then((value) => {
      latestVersionCache.set(provider, {
        expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
        value,
      });
      return value;
    })
    .catch((error) => {
      const value: LatestVersionResult = {
        latestVersionError: error instanceof Error ? error.message : String(error),
      };
      latestVersionCache.set(provider, {
        expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
        value,
      });
      return value;
    })
    .finally(() => {
      if (latestVersionInFlight.get(provider) === request) {
        latestVersionInFlight.delete(provider);
      }
    });
  latestVersionInFlight.set(provider, request);
  return request;
}

export async function probeProviderDiagnostic(
  provider: ProviderKind,
  launchSpec: LaunchSpec,
  options?: {
    forceRefresh?: boolean;
  },
): Promise<ProviderDiagnostic> {
  const latest = await getLatestVersionResult(provider, options);
  const launchCommand = launchSpec.argv.join(" ");
  const [command, ...baseArgs] = launchSpec.argv;
  if (!command) {
    return buildProviderDiagnostic({
      provider,
      status: "missing_binary",
      launchCommand,
      latest,
      versionStatus: "unknown",
      detail: "No launch command configured.",
    });
  }

  return new Promise((resolve) => {
    const child = spawn(command, [...baseArgs, "--version"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve(buildProviderDiagnostic({
        provider,
        status: "launch_error",
        launchCommand,
        latest,
        versionStatus: "unknown",
        detail: "Timed out while probing provider version.",
      }));
    }, 5_000);

    child.stdout.on("data", (chunk) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(buildProviderDiagnostic({
        provider,
        status: error.message.includes("ENOENT") ? "missing_binary" : "launch_error",
        launchCommand,
        latest,
        versionStatus: "unknown",
        detail: error.message,
      }));
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      const installedVersion = extractVersionString(stdoutText || stderrText);
      if (code === 0) {
        resolve(buildProviderDiagnostic({
          provider,
          status: "ready",
          launchCommand,
          latest,
          ...(installedVersion ? { installedVersion } : {}),
          versionStatus: compareVersions(installedVersion, latest.latestVersion),
        }));
        return;
      }
      resolve(buildProviderDiagnostic({
        provider,
        status: "launch_error",
        launchCommand,
        latest,
        ...(installedVersion ? { installedVersion } : {}),
        versionStatus: compareVersions(installedVersion, latest.latestVersion),
        detail: stderrText || `Exited with code ${code ?? 0}.`,
      }));
    });
  });
}
