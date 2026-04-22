import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AttachSessionRequest,
  ClaimControlRequest,
  CloseSessionRequest,
  DetachSessionRequest,
  DebugReplayScript,
  EventSubscriptionRequest,
  InterruptSessionRequest,
  ListDebugScenariosResponse,
  ListProvidersResponse,
  PermissionResponseRequest,
  PtyClientMessage,
  ReplayGapNotice,
  ReleaseControlRequest,
  ResumeSessionRequest,
  SessionInputRequest,
  StartDebugScenarioRequest,
  StartSessionRequest,
  StoredSessionRemoveRequest,
  WorkspaceDirectoryRequest,
} from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";

export interface RahDaemon {
  port: number;
  close(): Promise<void>;
}

const CLIENT_DIST_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "client-web",
  "dist",
);
const CLIENT_INDEX_PATH = resolve(CLIENT_DIST_ROOT, "index.html");

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

type JsonHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  body: unknown,
) => Promise<void>;

function applyCorsHeaders(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  applyCorsHeaders(res);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeText(res: ServerResponse, status: number, body: string): void {
  applyCorsHeaders(res);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function replayGapForSubscription(
  engine: RuntimeEngine,
  filter: EventSubscriptionRequest,
): ReplayGapNotice | undefined {
  if (filter.replayFromSeq === undefined) {
    return undefined;
  }
  const oldestAvailableSeq = engine.eventBus.oldestSeq();
  if (oldestAvailableSeq === null || filter.replayFromSeq >= oldestAvailableSeq) {
    return undefined;
  }
  return {
    requestedFromSeq: filter.replayFromSeq,
    oldestAvailableSeq,
    newestAvailableSeq: engine.eventBus.newestSeq(),
  };
}

function sameEventSubscription(
  left: EventSubscriptionRequest,
  right: EventSubscriptionRequest,
): boolean {
  const leftSessionIds = left.sessionIds ?? [];
  const rightSessionIds = right.sessionIds ?? [];
  const leftEventTypes = left.eventTypes ?? [];
  const rightEventTypes = right.eventTypes ?? [];

  return (
    left.replayFromSeq === right.replayFromSeq &&
    leftSessionIds.length === rightSessionIds.length &&
    leftSessionIds.every((value, index) => value === rightSessionIds[index]) &&
    leftEventTypes.length === rightEventTypes.length &&
    leftEventTypes.every((value, index) => value === rightEventTypes[index])
  );
}

function contentTypeForPath(path: string): string {
  return CONTENT_TYPE_BY_EXTENSION[extname(path)] ?? "application/octet-stream";
}

async function tryReadFile(path: string): Promise<Buffer | null> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return null;
    }
    return await readFile(path);
  } catch {
    return null;
  }
}

function resolveClientAssetPath(pathname: string): string | null {
  const cleaned = pathname === "/" ? "/index.html" : pathname;
  const candidate = resolve(CLIENT_DIST_ROOT, cleaned.replace(/^\/+/, ""));
  const rel = relative(CLIENT_DIST_ROOT, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return candidate;
}

async function serveStaticFile(
  res: ServerResponse,
  path: string,
  options?: { cacheControl?: string },
): Promise<boolean> {
  const body = await tryReadFile(path);
  if (!body) {
    return false;
  }
  applyCorsHeaders(res);
  res.writeHead(200, {
    "content-type": contentTypeForPath(path),
    "content-length": body.byteLength,
    "cache-control": options?.cacheControl ?? "no-cache",
  });
  res.end(body);
  return true;
}

async function serveClientApp(pathname: string, res: ServerResponse): Promise<boolean> {
  const assetPath = resolveClientAssetPath(pathname);
  if (assetPath) {
    const cacheControl =
      pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    if (await serveStaticFile(res, assetPath, { cacheControl })) {
      return true;
    }
  }

  const expectsHtml = pathname === "/" || extname(pathname) === "";
  if (!expectsHtml) {
    return false;
  }

  if (await serveStaticFile(res, CLIENT_INDEX_PATH)) {
    return true;
  }

  writeText(
    res,
    503,
    "RAH client bundle not found. Run `bun --cwd packages/client-web vite build` first.",
  );
  return true;
}

export async function startRahDaemon(options?: { port?: number }): Promise<RahDaemon> {
  const port = options?.port ?? 43111;
  const engine = new RuntimeEngine();

  const postRoutes: Array<{ pattern: RegExp; handler: JsonHandler }> = [
    {
      pattern: /^\/api\/sessions\/start$/,
      handler: async (_req, res, _match, body) => {
        const result = await engine.startSession((body ?? {}) as StartSessionRequest);
        writeJson(res, 200, result);
      },
    },
    {
      pattern: /^\/api\/sessions\/resume$/,
      handler: async (_req, res, _match, body) => {
        const result = await engine.resumeSession((body ?? {}) as ResumeSessionRequest);
        writeJson(res, 200, result);
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/attach$/,
      handler: async (_req, res, match, body) => {
        const result = engine.attachSession(match[1]!, (body ?? {}) as AttachSessionRequest);
        writeJson(res, 200, result);
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/control\/claim$/,
      handler: async (_req, res, match, body) => {
        const result = engine.claimControl(match[1]!, (body ?? {}) as ClaimControlRequest);
        writeJson(res, 200, { session: result });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/control\/release$/,
      handler: async (_req, res, match, body) => {
        const result = engine.releaseControl(match[1]!, (body ?? {}) as ReleaseControlRequest);
        writeJson(res, 200, { session: result });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/input$/,
      handler: async (_req, res, match, body) => {
        engine.sendInput(match[1]!, (body ?? {}) as SessionInputRequest);
        writeJson(res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/interrupt$/,
      handler: async (_req, res, match, body) => {
        const result = engine.interruptSession(
          match[1]!,
          (body ?? {}) as InterruptSessionRequest,
        );
        writeJson(res, 200, { session: result });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/detach$/,
      handler: async (_req, res, match, body) => {
        const result = engine.detachSession(match[1]!, (body ?? {}) as DetachSessionRequest);
        writeJson(res, 200, { session: result });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/close$/,
      handler: async (_req, res, match, body) => {
        await engine.closeSession(match[1]!, (body ?? {}) as CloseSessionRequest);
        writeJson(res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/permissions\/([^/]+)\/respond$/,
      handler: async (_req, res, match, body) => {
        await engine.respondToPermission(
          match[1]!,
          decodeURIComponent(match[2]!),
          (body ?? {}) as PermissionResponseRequest,
        );
        writeJson(res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/workspaces\/add$/,
      handler: async (_req, res, _match, body) => {
        writeJson(res, 200, engine.addWorkspace(((body ?? {}) as WorkspaceDirectoryRequest).dir));
      },
    },
    {
      pattern: /^\/api\/workspaces\/select$/,
      handler: async (_req, res, _match, body) => {
        writeJson(
          res,
          200,
          engine.selectWorkspace(((body ?? {}) as WorkspaceDirectoryRequest).dir),
        );
      },
    },
    {
      pattern: /^\/api\/workspaces\/remove$/,
      handler: async (_req, res, _match, body) => {
        writeJson(
          res,
          200,
          engine.removeWorkspace(((body ?? {}) as WorkspaceDirectoryRequest).dir),
        );
      },
    },
    {
      pattern: /^\/api\/history\/sessions\/remove$/,
      handler: async (_req, res, _match, body) => {
        const request = (body ?? {}) as StoredSessionRemoveRequest;
        writeJson(
          res,
          200,
          await engine.removeStoredSession(request.provider, request.providerSessionId),
        );
      },
    },
    {
      pattern: /^\/api\/history\/workspaces\/remove$/,
      handler: async (_req, res, _match, body) => {
        const request = (body ?? {}) as WorkspaceDirectoryRequest;
        writeJson(res, 200, await engine.removeStoredWorkspaceSessions(request.dir));
      },
    },
  ];

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        writeText(res, 400, "Bad Request");
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname;

      if (req.method === "OPTIONS") {
        applyCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && pathname === "/readyz") {
        writeText(res, 200, "ok");
        return;
      }

      if (req.method === "GET" && pathname === "/api/sessions") {
        writeJson(res, 200, engine.listSessions());
        return;
      }

      if (req.method === "GET" && pathname === "/api/fs/list") {
        const dirPath = url.searchParams.get("path") ?? process.cwd();
        try {
          writeJson(res, 200, await engine.listDirectory(dirPath));
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/fs/ensure-dir") {
        const body = (await readJsonBody(req)) as WorkspaceDirectoryRequest | undefined;
        try {
          writeJson(res, 200, await engine.ensureDirectory(body?.dir ?? process.cwd()));
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/debug/scenarios") {
        const response: ListDebugScenariosResponse = {
          scenarios: engine.listScenarios(),
        };
        writeJson(res, 200, response);
        return;
      }

      if (req.method === "GET" && pathname === "/api/providers") {
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const response: ListProvidersResponse = {
          providers: await engine.listProviderDiagnostics({ forceRefresh }),
        };
        writeJson(res, 200, response);
        return;
      }

      if (req.method === "GET" && pathname === "/api/workbenches") {
        writeJson(res, 200, { workbenches: [engine.sessionStore.getWorkbench()] });
        return;
      }

      const workbenchMatch = /^\/api\/workbenches\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && workbenchMatch) {
        writeJson(res, 200, { workbench: engine.sessionStore.getWorkbench() });
        return;
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (req.method === "GET" && sessionMatch) {
        writeJson(res, 200, { session: engine.getSessionSummary(sessionMatch[1]!) });
        return;
      }

      const workspaceMatch = /^\/api\/sessions\/([^/]+)\/workspace$/.exec(pathname);
      if (req.method === "GET" && workspaceMatch) {
        writeJson(res, 200, engine.getWorkspaceSnapshot(workspaceMatch[1]!));
        return;
      }

      const filesMatch = /^\/api\/sessions\/([^/]+)\/files$/.exec(pathname);
      if (req.method === "GET" && filesMatch) {
        writeJson(res, 200, engine.getWorkspaceSnapshot(filesMatch[1]!));
        return;
      }

      const gitStatusMatch = /^\/api\/sessions\/([^/]+)\/git-status$/.exec(pathname);
      if (req.method === "GET" && gitStatusMatch) {
        writeJson(res, 200, engine.getGitStatus(gitStatusMatch[1]!));
        return;
      }

      const gitDiffMatch = /^\/api\/sessions\/([^/]+)\/git-diff$/.exec(pathname);
      if (req.method === "GET" && gitDiffMatch) {
        const diffPath = url.searchParams.get("path") ?? "src/index.ts";
        writeJson(res, 200, engine.getGitDiff(gitDiffMatch[1]!, diffPath));
        return;
      }

      const fileMatch = /^\/api\/sessions\/([^/]+)\/file$/.exec(pathname);
      if (req.method === "GET" && fileMatch) {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          writeJson(res, 400, { error: "File path is required." });
          return;
        }
        writeJson(res, 200, engine.readSessionFile(fileMatch[1]!, filePath));
        return;
      }

      const historyMatch = /^\/api\/sessions\/([^/]+)\/history$/.exec(pathname);
      if (req.method === "GET" && historyMatch) {
        const beforeTs = url.searchParams.get("beforeTs") ?? undefined;
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit =
          limitRaw && Number.isFinite(Number.parseInt(limitRaw, 10))
            ? Number.parseInt(limitRaw, 10)
            : undefined;
        const options = {
          ...(beforeTs !== undefined ? { beforeTs } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        };
        writeJson(
          res,
          200,
          engine.getSessionHistoryPage(historyMatch[1]!, options),
        );
        return;
      }

      const usageMatch = /^\/api\/sessions\/([^/]+)\/usage$/.exec(pathname);
      if (req.method === "GET" && usageMatch) {
        writeJson(res, 200, {
          sessionId: usageMatch[1],
          usage: engine.getContextUsage(usageMatch[1]!),
        });
        return;
      }

      const replayMatch = /^\/api\/debug\/scenarios\/([^/]+)\/replay$/.exec(pathname);
      if (req.method === "GET" && replayMatch) {
        const script: DebugReplayScript = engine.buildScenarioReplayScript(replayMatch[1]!);
        writeJson(res, 200, script);
        return;
      }

      if (req.method === "GET" && !pathname.startsWith("/api/")) {
        if (await serveClientApp(pathname, res)) {
          return;
        }
      }

      if (req.method === "POST") {
        if (pathname === "/api/debug/scenarios/start") {
          const body = await readJsonBody(req);
          const parsed = (body ?? {}) as Partial<StartDebugScenarioRequest>;
          if (!parsed.scenarioId) {
            writeJson(res, 400, { error: "scenarioId is required" });
            return;
          }
          const request = { scenarioId: parsed.scenarioId };
          const result = engine.startScenario(
            parsed.attach !== undefined
              ? { ...request, attach: parsed.attach }
              : request,
          );
          writeJson(res, 200, result);
          return;
        }
        const route = postRoutes.find(({ pattern }) => pattern.test(pathname));
        if (!route) {
          writeText(res, 404, "Not Found");
          return;
        }
        const match = route.pattern.exec(pathname);
        if (!match) {
          writeText(res, 404, "Not Found");
          return;
        }
        const body = await readJsonBody(req);
        await route.handler(req, res, match, body);
        return;
      }

      writeText(res, 404, "Not Found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(res, 500, { error: message });
    }
  });

  const wssEvents = new WebSocketServer({ noServer: true });
  const wssPty = new WebSocketServer({ noServer: true });

  wssEvents.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const replayFromSeq = url.searchParams.get("replayFromSeq");
    let filter: EventSubscriptionRequest = {};
    if (replayFromSeq && Number.isFinite(Number.parseInt(replayFromSeq, 10))) {
      filter.replayFromSeq = Number.parseInt(replayFromSeq, 10);
    }

    const initial = engine.listEvents(filter);
    const initialReplayGap = replayGapForSubscription(engine, filter);
    if (initial.length > 0 || initialReplayGap) {
      socket.send(
        JSON.stringify({
          events: initial,
          initial: true,
          ...(initialReplayGap ? { replayGap: initialReplayGap } : {}),
        }),
      );
    }

    let unsubscribe = engine.eventBus.subscribe(filter, (event) => {
      socket.send(JSON.stringify({ events: [event] }));
    });

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as EventSubscriptionRequest;
        if (sameEventSubscription(filter, parsed)) {
          return;
        }
        unsubscribe();
        filter = parsed;
        const replay = engine.listEvents(filter);
        const replayGap = replayGapForSubscription(engine, filter);
        if (replay.length > 0 || replayGap) {
          socket.send(
            JSON.stringify({
              events: replay,
              ...(replayGap ? { replayGap } : {}),
            }),
          );
        }
        unsubscribe = engine.eventBus.subscribe(filter, (event) => {
          socket.send(JSON.stringify({ events: [event] }));
        });
      } catch {
        socket.send(JSON.stringify({ error: "Invalid subscription payload" }));
      }
    });

    socket.on("close", () => {
      unsubscribe();
    });
  });

  wssPty.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/api\/pty\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      socket.close();
      return;
    }
    const sessionId = match[1]!;
    const replay = url.searchParams.get("replay") !== "false";
    const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
      socket.send(JSON.stringify(frame));
    }, replay);

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as PtyClientMessage;
        if (parsed.type === "pty.input") {
          engine.onPtyInput(parsed.sessionId, parsed.clientId, parsed.data);
        } else if (parsed.type === "pty.resize") {
          engine.onPtyResize(parsed.sessionId, parsed.clientId, parsed.cols, parsed.rows);
        }
      } catch {
        socket.send(JSON.stringify({ error: "Invalid PTY client payload" }));
      }
    });

    socket.on("close", () => {
      unsubscribe();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/events") {
      wssEvents.handleUpgrade(req, socket, head, (ws) => {
        wssEvents.emit("connection", ws, req);
      });
      return;
    }
    if (/^\/api\/pty\/[^/]+$/.test(url.pathname)) {
      wssPty.handleUpgrade(req, socket, head, (ws) => {
        wssPty.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve());
  });

  return {
    port,
    async close() {
      await engine.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      wssEvents.close();
      wssPty.close();
    },
  };
}
