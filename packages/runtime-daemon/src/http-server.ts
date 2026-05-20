import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RuntimeIdentityResponse } from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import { createPostRoutes, handleHttpRequest } from "./http-server-routes";
import { attachWebSocketHandlers } from "./http-server-websocket";

export interface RahDaemon {
  port: number;
  close(): Promise<void>;
}

function readRootPackageVersion(rootDir: string): string | undefined {
  try {
    const raw = readFileSync(path.join(rootDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function readSourceRevision(rootDir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function readSourceDirty(rootDir: string): boolean | undefined {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim().length > 0;
  } catch {
    return undefined;
  }
}

function createRuntimeIdentity(port: number): RuntimeIdentityResponse {
  const rootDir = process.cwd();
  const version = readRootPackageVersion(rootDir);
  const sourceRevision = readSourceRevision(rootDir);
  const sourceDirty = readSourceDirty(rootDir);
  return {
    name: "rah",
    runtimeId: randomUUID(),
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    rootDir,
    ...(version ? { version } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(sourceDirty !== undefined ? { sourceDirty } : {}),
  };
}

export async function startRahDaemon(options?: {
  port?: number;
  engine?: RuntimeEngine;
}): Promise<RahDaemon> {
  const port = options?.port ?? 43111;
  const engine = options?.engine ?? new RuntimeEngine();
  const postRoutes = createPostRoutes(engine);
  let runtimeIdentity: RuntimeIdentityResponse | undefined;

  const server = createServer(async (req, res) => {
    await handleHttpRequest({ engine, postRoutes, req, res, runtimeIdentity });
  });
  const websockets = attachWebSocketHandlers(server, engine);

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  runtimeIdentity = createRuntimeIdentity(actualPort);

  return {
    port: actualPort,
    async close() {
      try {
        await engine.shutdown();
      } catch (error) {
        console.error("[rah] engine shutdown failed", error);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      } finally {
        websockets.close();
      }
    },
  };
}
