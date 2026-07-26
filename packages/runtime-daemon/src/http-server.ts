import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RuntimeIdentityResponse } from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import { createPostRoutes, handleHttpRequest } from "./http-server-routes";
import { attachWebSocketHandlers } from "./http-server-websocket";
import { DeviceAuthManager } from "./device-auth";
import { runBackgroundCommand } from "./background-command";

export interface RahDaemon {
  host: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_HTTP_DRAIN_TIMEOUT_MS = 5_000;

function readRootPackageVersion(rootDir: string): string | undefined {
  try {
    const raw = readFileSync(path.join(rootDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function readSourceState(
  rootDir: string,
): Promise<{ sourceRevision?: string; sourceDirty?: boolean }> {
  try {
    const result = await runBackgroundCommand({
      command: "git",
      args: ["status", "--porcelain=v2", "--branch"],
      cwd: rootDir,
      label: "RAH source identity",
      timeoutMs: 3_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 128 * 1024,
    });
    const lines = result.stdout.split(/\r?\n/);
    const oid = lines
      .find((line) => line.startsWith("# branch.oid "))
      ?.slice("# branch.oid ".length)
      .trim();
    const sourceRevision =
      oid && oid !== "(initial)" ? oid.slice(0, 7) : undefined;
    const sourceDirty = lines.some(
      (line) => line.length > 0 && !line.startsWith("# "),
    );
    return {
      ...(sourceRevision ? { sourceRevision } : {}),
      sourceDirty,
    };
  } catch {
    return {};
  }
}

async function createRuntimeIdentity(
  port: number,
): Promise<RuntimeIdentityResponse> {
  const rootDir = process.cwd();
  const version = readRootPackageVersion(rootDir);
  const { sourceRevision, sourceDirty } = await readSourceState(rootDir);
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
  httpDrainTimeoutMs?: number;
}): Promise<RahDaemon> {
  const host = options?.host ?? "0.0.0.0";
  const port = options?.port ?? 43111;
  const engine = options?.engine ?? new RuntimeEngine();
  const auth = options?.auth === false ? undefined : options?.auth ?? new DeviceAuthManager();
  const httpDrainTimeoutMs = options?.httpDrainTimeoutMs ?? DEFAULT_HTTP_DRAIN_TIMEOUT_MS;
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
  runtimeIdentity = await createRuntimeIdentity(actualPort);

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

          const forceDrainTimer = setTimeout(() => {
            server.closeAllConnections();
          }, Math.max(0, httpDrainTimeoutMs));
          forceDrainTimer.unref?.();

          let engineShutdownError: unknown;
          const engineShutdown = engine.shutdown().catch((error) => {
            engineShutdownError = error;
            console.error("[rah] engine shutdown failed", error);
          });

          let webSocketCloseError: unknown;
          try {
            await websockets.close();
          } catch (error) {
            webSocketCloseError = error;
          }
          await Promise.all([serverClosed, engineShutdown]);
          clearTimeout(forceDrainTimer);

          if (serverCloseError || webSocketCloseError || engineShutdownError) {
            throw new AggregateError(
              [serverCloseError, webSocketCloseError, engineShutdownError].filter(
                (error) => error !== undefined,
              ),
              "RAH shutdown failed.",
            );
          }
        })();
      }
      return closePromise;
    },
  };
}
