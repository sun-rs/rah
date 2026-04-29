import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DebugReplayScript,
  ListDebugScenariosResponse,
  ListProvidersResponse,
  ProviderKind,
} from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import { applyCorsHeaders, validateApiRequest } from "./http-server-cors";
import {
  type JsonHandler,
  readJsonBody,
  requestErrorStatus,
  writeJson,
  writeText,
} from "./http-server-response";
import {
  parseAttachSessionRequest,
  parseClaimControlRequest,
  parseCloseSessionRequest,
  parseDetachSessionRequest,
  parseGitFileActionRequest,
  parseGitHunkActionRequest,
  parseIndependentTerminalStartRequest,
  parseInterruptSessionRequest,
  parsePermissionResponseRequest,
  parseReleaseControlRequest,
  parseRenameSessionRequest,
  parseResumeSessionRequest,
  parseSessionInputRequest,
  parseSetSessionModeRequest,
  parseSetSessionModelRequest,
  parseStartDebugScenarioRequest,
  parseStartSessionRequest,
  parseStoredSessionRemoveRequest,
  parseWorkspaceDirectoryRequest,
} from "./http-server-request-validation";
import { serveClientApp } from "./http-server-static";

export function createPostRoutes(
  engine: RuntimeEngine,
): Array<{ pattern: RegExp; handler: JsonHandler }> {
  return [
    {
      pattern: /^\/api\/terminal\/start$/,
      handler: async (req, res, _match, body) => {
        writeJson(
          req,
          res,
          200,
          await engine.startIndependentTerminal(parseIndependentTerminalStartRequest(body)),
        );
      },
    },
    {
      pattern: /^\/api\/terminal\/([^/]+)\/close$/,
      handler: async (req, res, match) => {
        await engine.closeIndependentTerminal(match[1]!);
        writeJson(req, res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/sessions\/start$/,
      handler: async (req, res, _match, body) => {
        const result = await engine.startSession(parseStartSessionRequest(body));
        writeJson(req, res, 200, result);
      },
    },
    {
      pattern: /^\/api\/sessions\/resume$/,
      handler: async (req, res, _match, body) => {
        const result = await engine.resumeSession(parseResumeSessionRequest(body));
        writeJson(req, res, 200, result);
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/attach$/,
      handler: async (req, res, match, body) => {
        const result = engine.attachSession(match[1]!, parseAttachSessionRequest(body));
        writeJson(req, res, 200, result);
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/control\/claim$/,
      handler: async (req, res, match, body) => {
        const result = engine.claimControl(match[1]!, parseClaimControlRequest(body));
        writeJson(req, res, 200, { session: result });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/control\/release$/,
      handler: async (req, res, match, body) => {
        const result = engine.releaseControl(match[1]!, parseReleaseControlRequest(body));
        writeJson(req, res, 200, { session: result });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/input$/,
      handler: async (req, res, match, body) => {
        engine.sendInput(match[1]!, parseSessionInputRequest(body));
        writeJson(req, res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/git-files\/apply$/,
      handler: async (req, res, match, body) => {
        writeJson(
          req,
          res,
          200,
          await engine.applyGitFileAction(match[1]!, parseGitFileActionRequest(body)),
        );
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/git-hunks\/apply$/,
      handler: async (req, res, match, body) => {
        writeJson(
          req,
          res,
          200,
          await engine.applyGitHunkAction(match[1]!, parseGitHunkActionRequest(body)),
        );
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/interrupt$/,
      handler: async (req, res, match, body) => {
        const result = engine.interruptSession(
          match[1]!,
            parseInterruptSessionRequest(body),
        );
        writeJson(req, res, 200, { session: result });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/detach$/,
      handler: async (req, res, match, body) => {
        const result = engine.detachSession(match[1]!, parseDetachSessionRequest(body));
        writeJson(req, res, 200, { session: result });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/close$/,
      handler: async (req, res, match, body) => {
        await engine.closeSession(match[1]!, parseCloseSessionRequest(body));
        writeJson(req, res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/rename$/,
      handler: async (req, res, match, body) => {
        const request = parseRenameSessionRequest(body);
        writeJson(req, res, 200, {
          session: await engine.renameSession(match[1]!, request.title),
        });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/mode$/,
      handler: async (req, res, match, body) => {
        const request = parseSetSessionModeRequest(body);
        writeJson(req, res, 200, {
          session: await engine.setSessionMode(match[1]!, request.modeId),
        });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/model$/,
      handler: async (req, res, match, body) => {
        const request = parseSetSessionModelRequest(body);
        writeJson(req, res, 200, {
          session: await engine.setSessionModel(match[1]!, request),
        });
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/permissions\/([^/]+)\/respond$/,
      handler: async (req, res, match, body) => {
        await engine.respondToPermission(
          match[1]!,
          decodeURIComponent(match[2]!),
          parsePermissionResponseRequest(body),
        );
        writeJson(req, res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/workspaces\/add$/,
      handler: async (req, res, _match, body) => {
        writeJson(req, res, 200, engine.addWorkspace(parseWorkspaceDirectoryRequest(body).dir));
      },
    },
    {
      pattern: /^\/api\/workspaces\/select$/,
      handler: async (req, res, _match, body) => {
        writeJson(
          req,
          res,
          200,
          engine.selectWorkspace(parseWorkspaceDirectoryRequest(body).dir),
        );
      },
    },
    {
      pattern: /^\/api\/workspaces\/remove$/,
      handler: async (req, res, _match, body) => {
        writeJson(
          req,
          res,
          200,
          engine.removeWorkspace(parseWorkspaceDirectoryRequest(body).dir),
        );
      },
    },
    {
      pattern: /^\/api\/history\/sessions\/remove$/,
      handler: async (req, res, _match, body) => {
        const request = parseStoredSessionRemoveRequest(body);
        writeJson(
          req,
          res,
          200,
          await engine.removeStoredSession(request.provider, request.providerSessionId),
        );
      },
    },
    {
      pattern: /^\/api\/history\/workspaces\/remove$/,
      handler: async (req, res, _match, body) => {
        const request = parseWorkspaceDirectoryRequest(body);
        writeJson(req, res, 200, await engine.removeStoredWorkspaceSessions(request.dir));
      },
    },
  ];
}

export async function handleHttpRequest(args: {
  engine: RuntimeEngine;
  postRoutes: Array<{ pattern: RegExp; handler: JsonHandler }>;
  req: IncomingMessage;
  res: ServerResponse;
}): Promise<void> {
  const { engine, postRoutes, req, res } = args;
  try {
    if (!req.url || !req.method) {
      writeText(req, res, 400, "Bad Request");
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;

    const apiValidationError = validateApiRequest(req, pathname);
    if (apiValidationError) {
      writeJson(req, res, 403, { error: apiValidationError });
      return;
    }

    if (req.method === "OPTIONS") {
      applyCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/readyz") {
      writeText(req, res, 200, "ok");
      return;
    }

    if (req.method === "GET" && pathname === "/api/sessions") {
      writeJson(req, res, 200, engine.listSessions());
      return;
    }

    if (req.method === "GET" && pathname === "/api/fs/list") {
      const dirPath = url.searchParams.get("path") ?? process.cwd();
      try {
        writeJson(req, res, 200, await engine.listDirectory(dirPath));
      } catch (error) {
        writeJson(req, res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/fs/ensure-dir") {
      const body = await readJsonBody(req);
      try {
        const dir = body === undefined ? process.cwd() : parseWorkspaceDirectoryRequest(body).dir;
        writeJson(req, res, 200, await engine.ensureDirectory(dir));
      } catch (error) {
        writeJson(req, res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/debug/scenarios") {
      const response: ListDebugScenariosResponse = {
        scenarios: engine.listScenarios(),
      };
      writeJson(req, res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/api/providers") {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const response: ListProvidersResponse = {
        providers: await engine.listProviderDiagnostics({ forceRefresh }),
      };
      writeJson(req, res, 200, response);
      return;
    }

    const providerModelsMatch = /^\/api\/providers\/([^/]+)\/models$/.exec(pathname);
    if (req.method === "GET" && providerModelsMatch) {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const cwd = url.searchParams.get("cwd") ?? undefined;
      writeJson(req, res, 200, {
        catalog: await engine.listProviderModels(providerModelsMatch[1]! as ProviderKind, {
          ...(cwd ? { cwd } : {}),
          forceRefresh,
        }),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/workbenches") {
      writeJson(req, res, 200, { workbenches: [engine.sessionStore.getWorkbench()] });
      return;
    }

    const workbenchMatch = /^\/api\/workbenches\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && workbenchMatch) {
      writeJson(req, res, 200, { workbench: engine.sessionStore.getWorkbench() });
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && sessionMatch) {
      writeJson(req, res, 200, { session: engine.getSessionSummary(sessionMatch[1]!) });
      return;
    }

    const workspaceMatch = /^\/api\/sessions\/([^/]+)\/workspace$/.exec(pathname);
    if (req.method === "GET" && workspaceMatch) {
      const scopeRoot = url.searchParams.get("scopeRoot") ?? undefined;
      writeJson(
        req,
        res,
        200,
        engine.getWorkspaceSnapshot(workspaceMatch[1]!, {
          ...(scopeRoot ? { scopeRoot } : {}),
        }),
      );
      return;
    }

    const filesMatch = /^\/api\/sessions\/([^/]+)\/files$/.exec(pathname);
    if (req.method === "GET" && filesMatch) {
      const scopeRoot = url.searchParams.get("scopeRoot") ?? undefined;
      writeJson(
        req,
        res,
        200,
        engine.getWorkspaceSnapshot(filesMatch[1]!, {
          ...(scopeRoot ? { scopeRoot } : {}),
        }),
      );
      return;
    }

    const gitStatusMatch = /^\/api\/sessions\/([^/]+)\/git-status$/.exec(pathname);
    if (req.method === "GET" && gitStatusMatch) {
      const scopeRoot = url.searchParams.get("scopeRoot") ?? undefined;
      writeJson(
        req,
        res,
        200,
        await engine.getGitStatus(gitStatusMatch[1]!, {
          ...(scopeRoot ? { scopeRoot } : {}),
        }),
      );
      return;
    }

    const gitDiffMatch = /^\/api\/sessions\/([^/]+)\/git-diff$/.exec(pathname);
    if (req.method === "GET" && gitDiffMatch) {
      const diffPath = url.searchParams.get("path") ?? "src/index.ts";
      const staged = url.searchParams.get("staged");
      const ignoreWhitespace = url.searchParams.get("ignoreWhitespace");
      const scopeRoot = url.searchParams.get("scopeRoot") ?? undefined;
      writeJson(
        req,
        res,
        200,
        await engine.getGitDiff(gitDiffMatch[1]!, diffPath, {
          ...(staged !== null ? { staged: staged === "true" } : {}),
          ...(ignoreWhitespace !== null
            ? { ignoreWhitespace: ignoreWhitespace === "true" }
            : {}),
          ...(scopeRoot ? { scopeRoot } : {}),
        }),
      );
      return;
    }

    const fileMatch = /^\/api\/sessions\/([^/]+)\/file$/.exec(pathname);
    if (req.method === "GET" && fileMatch) {
      const filePath = url.searchParams.get("path");
      const scopeRoot = url.searchParams.get("scopeRoot") ?? undefined;
      if (!filePath) {
        writeJson(req, res, 400, { error: "File path is required." });
        return;
      }
      writeJson(
        req,
        res,
        200,
        await engine.readSessionFile(fileMatch[1]!, filePath, {
          ...(scopeRoot ? { scopeRoot } : {}),
        }),
      );
      return;
    }

    const fileSearchMatch = /^\/api\/sessions\/([^/]+)\/file-search$/.exec(pathname);
    if (req.method === "GET" && fileSearchMatch) {
      const query = url.searchParams.get("query") ?? "";
      const limitRaw = url.searchParams.get("limit");
      const scopeRoot = url.searchParams.get("scopeRoot") ?? undefined;
      const limit =
        limitRaw && Number.isFinite(Number.parseInt(limitRaw, 10))
          ? Number.parseInt(limitRaw, 10)
          : 100;
      writeJson(
        req,
        res,
        200,
        await engine.searchSessionFiles(fileSearchMatch[1]!, query, limit, {
          ...(scopeRoot ? { scopeRoot } : {}),
        }),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/api/workspace/git-status") {
      const dir = url.searchParams.get("dir");
      if (!dir) {
        writeJson(req, res, 400, { error: "Workspace dir is required." });
        return;
      }
      writeJson(req, res, 200, await engine.getWorkspaceGitStatus(dir));
      return;
    }

    if (req.method === "GET" && pathname === "/api/workspace/git-diff") {
      const dir = url.searchParams.get("dir");
      const diffPath = url.searchParams.get("path");
      if (!dir || !diffPath) {
        writeJson(req, res, 400, { error: "Workspace dir and file path are required." });
        return;
      }
      const staged = url.searchParams.get("staged");
      const ignoreWhitespace = url.searchParams.get("ignoreWhitespace");
      writeJson(
        req,
        res,
        200,
        await engine.getWorkspaceGitDiff(dir, diffPath, {
          ...(staged !== null ? { staged: staged === "true" } : {}),
          ...(ignoreWhitespace !== null
            ? { ignoreWhitespace: ignoreWhitespace === "true" }
            : {}),
        }),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/api/workspace/file") {
      const dir = url.searchParams.get("dir");
      const filePath = url.searchParams.get("path");
      if (!dir || !filePath) {
        writeJson(req, res, 400, { error: "Workspace dir and file path are required." });
        return;
      }
      writeJson(req, res, 200, await engine.readWorkspaceFile(dir, filePath));
      return;
    }

    if (req.method === "GET" && pathname === "/api/workspace/file-search") {
      const dir = url.searchParams.get("dir");
      const query = url.searchParams.get("query") ?? "";
      if (!dir) {
        writeJson(req, res, 400, { error: "Workspace dir is required." });
        return;
      }
      const limitRaw = url.searchParams.get("limit");
      const limit =
        limitRaw && Number.isFinite(Number.parseInt(limitRaw, 10))
          ? Number.parseInt(limitRaw, 10)
          : 100;
      writeJson(req, res, 200, await engine.searchWorkspaceFiles(dir, query, limit));
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
      writeJson(req, res, 200, engine.getSessionHistoryPage(historyMatch[1]!, options));
      return;
    }

    const usageMatch = /^\/api\/sessions\/([^/]+)\/usage$/.exec(pathname);
    if (req.method === "GET" && usageMatch) {
      writeJson(req, res, 200, {
        sessionId: usageMatch[1],
        usage: engine.getContextUsage(usageMatch[1]!),
      });
      return;
    }

    const replayMatch = /^\/api\/debug\/scenarios\/([^/]+)\/replay$/.exec(pathname);
    if (req.method === "GET" && replayMatch) {
      const script: DebugReplayScript = engine.buildScenarioReplayScript(replayMatch[1]!);
      writeJson(req, res, 200, script);
      return;
    }

    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      if (await serveClientApp(pathname, req, res)) {
        return;
      }
    }

    if (req.method === "POST") {
      if (pathname === "/api/debug/scenarios/start") {
        const body = await readJsonBody(req);
        const parsed = parseStartDebugScenarioRequest(body);
        const result = engine.startScenario(parsed);
        writeJson(req, res, 200, result);
        return;
      }
      const route = postRoutes.find(({ pattern }) => pattern.test(pathname));
      if (!route) {
        writeText(req, res, 404, "Not Found");
        return;
      }
      const match = route.pattern.exec(pathname);
      if (!match) {
        writeText(req, res, 404, "Not Found");
        return;
      }
      const body = await readJsonBody(req);
      await route.handler(req, res, match, body);
      return;
    }

    writeText(req, res, 404, "Not Found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(req, res, requestErrorStatus(error), { error: message });
  }
}
