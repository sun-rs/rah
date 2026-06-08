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
  host: string;
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
  host?: string;
  port?: number;
  engine?: RuntimeEngine;
}): Promise<RahDaemon> {
  const host = options?.host ?? "0.0.0.0";
  const port = options?.port ?? 43111;
  let resolvedEngine: RuntimeEngine | undefined = options?.engine;
  let enginePromise: Promise<RuntimeEngine> | null = options?.engine
    ? Promise.resolve(options.engine)
    : null;
  const getEngine = () => {
    if (!enginePromise) {
      enginePromise = Promise.resolve().then(() => {
        resolvedEngine = new RuntimeEngine();
        return resolvedEngine;
      });
    }
    return enginePromise;
  };
  let postRoutesPromise: Promise<ReturnType<typeof createPostRoutes>> | null = null;
  const getPostRoutes = () => {
    if (!postRoutesPromise) {
      postRoutesPromise = getEngine().then((runtimeEngine) => createPostRoutes(runtimeEngine));
    }
    return postRoutesPromise;
  };
  let runtimeIdentity: RuntimeIdentityResponse | undefined;

  const server = createServer(async (req, res) => {
    await handleHttpRequest({
      engine: getEngine,
      postRoutes: getPostRoutes,
      req,
      res,
      runtimeIdentity,
    });
  });
  const websockets = attachWebSocketHandlers(server, getEngine);

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  runtimeIdentity = createRuntimeIdentity(actualPort);

  return {
    host,
    port: actualPort,
    async close() {
      try {
        const runtimeEngine =
          resolvedEngine ?? (enginePromise ? await enginePromise.catch(() => undefined) : undefined);
        await runtimeEngine?.shutdown();
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
