import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RuntimeIdentityResponse } from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import { createPostRoutes, handleHttpRequest } from "./http-server-routes";
import { attachWebSocketHandlers } from "./http-server-websocket";
import { DeviceAuthManager } from "./device-auth";

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
  auth?: DeviceAuthManager | false;
}): Promise<RahDaemon> {
  const host = options?.host ?? "0.0.0.0";
  const port = options?.port ?? 43111;
  const engine = options?.engine ?? new RuntimeEngine();
  const auth = options?.auth === false ? undefined : options?.auth ?? new DeviceAuthManager();
  const postRoutes = createPostRoutes(engine);
  let runtimeIdentity: RuntimeIdentityResponse | undefined;
  let closePromise: Promise<void> | undefined;

  const server = createServer(async (req, res) => {
    await handleHttpRequest({ engine, postRoutes, req, res, runtimeIdentity, auth });
  });
  const websockets = attachWebSocketHandlers(server, engine, auth);

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  runtimeIdentity = createRuntimeIdentity(actualPort);

  return {
    host,
    port: actualPort,
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          let serverCloseError: Error | undefined;
          const serverClosed = new Promise<void>((resolve) => {
            server.close((error) => {
              serverCloseError = error;
              resolve();
            });
          });

          let webSocketCloseError: unknown;
          try {
            await websockets.close();
          } catch (error) {
            webSocketCloseError = error;
          }
          await serverClosed;

          try {
            await engine.shutdown();
          } catch (error) {
            console.error("[rah] engine shutdown failed", error);
          }

          if (serverCloseError || webSocketCloseError) {
            throw new AggregateError(
              [serverCloseError, webSocketCloseError].filter((error) => error !== undefined),
              "RAH transport shutdown failed.",
            );
          }
        })();
      }
      return closePromise;
    },
  };
}
