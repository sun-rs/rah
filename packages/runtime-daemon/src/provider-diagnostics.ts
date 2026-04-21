import { spawn } from "node:child_process";
import type { ProviderDiagnostic, ProviderKind } from "@rah/runtime-protocol";

type LaunchSpec = {
  argv: string[];
};

export function codexLaunchSpec(): LaunchSpec {
  return {
    argv: [process.env.RAH_CODEX_BINARY ?? "codex"],
  };
}

export function claudeLaunchSpec(): LaunchSpec {
  return {
    argv: [process.env.RAH_CLAUDE_BINARY ?? "claude"],
  };
}

export function geminiLaunchSpec(): LaunchSpec {
  return {
    argv: [process.env.RAH_GEMINI_BINARY ?? "gemini"],
  };
}

export function kimiLaunchSpec(): LaunchSpec {
  if (process.env.RAH_KIMI_BINARY) {
    return { argv: [process.env.RAH_KIMI_BINARY] };
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

export async function probeProviderVersion(
  provider: ProviderKind,
  launchSpec: LaunchSpec,
): Promise<ProviderDiagnostic> {
  const launchCommand = launchSpec.argv.join(" ");
  const [command, ...baseArgs] = launchSpec.argv;
  if (!command) {
    return {
      provider,
      status: "missing_binary",
      launchCommand,
      detail: "No launch command configured.",
      auth: "provider_managed",
    };
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
      resolve({
        provider,
        status: "launch_error",
        launchCommand,
        detail: "Timed out while probing provider version.",
        auth: "provider_managed",
      });
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
      resolve({
        provider,
        status: error.message.includes("ENOENT") ? "missing_binary" : "launch_error",
        launchCommand,
        detail: error.message,
        auth: "provider_managed",
      });
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve({
          provider,
          status: "ready",
          launchCommand,
          ...(stdoutText ? { version: stdoutText } : stderrText ? { version: stderrText } : {}),
          auth: "provider_managed",
        });
        return;
      }
      resolve({
        provider,
        status: "launch_error",
        launchCommand,
        ...(stdoutText ? { version: stdoutText } : {}),
        detail: stderrText || `Exited with code ${code ?? 0}.`,
        auth: "provider_managed",
      });
    });
  });
}
