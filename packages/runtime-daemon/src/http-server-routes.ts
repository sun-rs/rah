import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CloseTuiMuxSessionResponse,
  DebugReplayScript,
  IndependentTerminalListResponse,
  ListDebugScenariosResponse,
  ListNativeTuiDiagnosticsResponse,
  ListPtyStatsResponse,
  ListTuiMuxDiagnosticsResponse,
  ListProvidersResponse,
  ProviderKind,
  RuntimeIdentityResponse,
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
  parseAddCouncilAgentRequest,
  parseAddManualProviderModelRequest,
  parseAttachSessionRequest,
  parseClaimControlRequest,
  parseClipboardWriteRequest,
  parseCloseSessionRequest,
  parseCouncilMcpRequest,
  parseCouncilPostMessageRequest,
  parseCreateCouncilRequest,
  parseDetachSessionRequest,
  parseGitFileActionRequest,
  parseGitHunkActionRequest,
  parseIndependentTerminalStartRequest,
  parseInterruptSessionRequest,
  parseNativeTuiSurfaceClaimRequest,
  parseNativeTuiClientCloseRequest,
  parseNativeTuiSurfaceReleaseRequest,
  parsePermissionResponseRequest,
  parseReleaseControlRequest,
  parseRenameCouncilRequest,
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
import { isLocalMachineRemoteAddress } from "./http-server-client-address";
import { writeHostClipboard } from "./host-clipboard";

const MAX_QUERY_LIMIT = 500;

function parseQueryLimit(raw: string | null, fallback?: number): number | undefined {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, MAX_QUERY_LIMIT);
}

function parseStoredSessionsModeFromUrl(url: URL): "all" | "recent" {
  return url.searchParams.get("storedSessions") === "recent" ? "recent" : "all";
}

function parseStoredSessionsModeFromRequest(req: IncomingMessage): "all" | "recent" {
  return parseStoredSessionsModeFromUrl(new URL(req.url ?? "", "http://127.0.0.1"));
}

export function createPostRoutes(
  engine: RuntimeEngine,
): Array<{ pattern: RegExp; handler: JsonHandler }> {
  return [
    {
      pattern: /^\/api\/providers\/([^/]+)\/manual-models$/,
      handler: async (req, res, match, body) => {
        writeJson(
          req,
          res,
          200,
          await engine.addManualProviderModel(
            decodeURIComponent(match[1]!) as ProviderKind,
            parseAddManualProviderModelRequest(body),
          ),
        );
      },
    },
    {
      pattern: /^\/api\/host\/clipboard$/,
      handler: async (req, res, _match, body) => {
        if (!isLocalMachineRemoteAddress(req.socket.remoteAddress)) {
          throw new Error("Host clipboard fallback is only available to local clients.");
        }
        const request = parseClipboardWriteRequest(body);
        await writeHostClipboard(request.text);
        writeJson(req, res, 200, { ok: true });
      },
    },
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
      pattern: /^\/api\/sessions\/([^/]+)\/tui-surface\/claim$/,
      handler: async (req, res, match, body) => {
        writeJson(
          req,
          res,
          200,
          await engine.claimNativeTuiSurface(
            decodeURIComponent(match[1]!),
            parseNativeTuiSurfaceClaimRequest(body),
          ),
        );
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/tui-surface\/release$/,
      handler: async (req, res, match, body) => {
        writeJson(
          req,
          res,
          200,
          await engine.releaseNativeTuiSurface(
            decodeURIComponent(match[1]!),
            parseNativeTuiSurfaceReleaseRequest(body),
          ),
        );
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/tui-client\/close$/,
      handler: async (req, res, match, body) => {
        writeJson(
          req,
          res,
          200,
          await engine.closeNativeTuiClient(
            decodeURIComponent(match[1]!),
            parseNativeTuiClientCloseRequest(body),
          ),
        );
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
      pattern: /^\/api\/tui-mux\/sessions\/([^/]+)\/close$/,
      handler: async (req, res, match) => {
        await engine.closeTuiMuxSession(decodeURIComponent(match[1]!));
        const response: CloseTuiMuxSessionResponse = { ok: true };
        writeJson(req, res, 200, response);
      },
    },
    {
      pattern: /^\/api\/workspaces\/add$/,
      handler: async (req, res, _match, body) => {
        writeJson(
          req,
          res,
          200,
          engine.addWorkspace(parseWorkspaceDirectoryRequest(body).dir, {
            storedSessionsMode: parseStoredSessionsModeFromRequest(req),
          }),
        );
      },
    },
    {
      pattern: /^\/api\/workspaces\/select$/,
      handler: async (req, res, _match, body) => {
        writeJson(
          req,
          res,
          200,
          engine.selectWorkspace(parseWorkspaceDirectoryRequest(body).dir, {
            storedSessionsMode: parseStoredSessionsModeFromRequest(req),
          }),
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
          engine.removeWorkspace(parseWorkspaceDirectoryRequest(body).dir, {
            storedSessionsMode: parseStoredSessionsModeFromRequest(req),
          }),
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
    {
      pattern: /^\/api\/council$/,
      handler: async (req, res, _match, body) => {
        writeJson(req, res, 200, await engine.createCouncil(parseCreateCouncilRequest(body)));
      },
    },
    {
      pattern: /^\/api\/council\/([^/]+)\/agents$/,
      handler: async (req, res, match, body) => {
        writeJson(
          req,
          res,
          200,
          await engine.addCouncilAgent(
            decodeURIComponent(match[1]!),
            parseAddCouncilAgentRequest(body),
          ),
        );
      },
    },
    {
      pattern: /^\/api\/council\/([^/]+)\/messages$/,
      handler: async (req, res, match, body) => {
        writeJson(
          req,
          res,
          200,
          engine.postCouncilMessage(decodeURIComponent(match[1]!), parseCouncilPostMessageRequest(body)),
        );
      },
    },
    {
      pattern: /^\/api\/council\/([^/]+)\/rename$/,
      handler: async (req, res, match, body) => {
        const request = parseRenameCouncilRequest(body);
        writeJson(req, res, 200, {
          council: engine.renameCouncil(decodeURIComponent(match[1]!), request.title),
        });
      },
    },
    {
      pattern: /^\/api\/council\/([^/]+)\/stop$/,
      handler: async (req, res, match) => {
        await engine.stopCouncil(decodeURIComponent(match[1]!));
        writeJson(req, res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/council\/([^/]+)\/delete$/,
      handler: async (req, res, match) => {
        engine.deleteCouncil(decodeURIComponent(match[1]!));
        writeJson(req, res, 200, { ok: true });
      },
    },
    {
      pattern: /^\/api\/council\/([^/]+)\/agents\/([^/]+)\/reinject$/,
      handler: async (req, res, match) => {
        writeJson(
          req,
          res,
          200,
          engine.reinjectCouncilAgentPrompt(
            decodeURIComponent(match[1]!),
            decodeURIComponent(match[2]!),
          ),
        );
      },
    },
    {
      pattern: /^\/api\/council\/([^/]+)\/agents\/([^/]+)\/remove$/,
      handler: async (req, res, match) => {
        writeJson(
          req,
          res,
          200,
          engine.removeCouncilAgent(
            decodeURIComponent(match[1]!),
            decodeURIComponent(match[2]!),
          ),
        );
      },
    },
    {
      pattern: /^\/api\/council\/([^/]+)\/agents\/([^/]+)\/stop$/,
      handler: async (req, res, match) => {
        writeJson(
          req,
          res,
          200,
          await engine.stopCouncilAgent(
            decodeURIComponent(match[1]!),
            decodeURIComponent(match[2]!),
          ),
        );
      },
    },
    {
      pattern: /^\/api\/council\/mcp$/,
      handler: async (req, res, _match, body) => {
        writeJson(req, res, 200, await engine.callCouncilMcpTool(parseCouncilMcpRequest(body)));
      },
    },
  ];
}

export async function handleHttpRequest(args: {
  engine: RuntimeEngine;
  postRoutes: Array<{ pattern: RegExp; handler: JsonHandler }>;
  req: IncomingMessage;
  res: ServerResponse;
  runtimeIdentity?: RuntimeIdentityResponse | undefined;
}): Promise<void> {
  const { engine, postRoutes, req, res, runtimeIdentity } = args;
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

    if (req.method === "GET" && pathname === "/api/runtime") {
      if (!runtimeIdentity) {
        writeJson(req, res, 503, { error: "Runtime identity is not ready." });
        return;
      }
      writeJson(req, res, 200, runtimeIdentity);
      return;
    }

    if (req.method === "GET" && pathname === "/api/sessions") {
      const storedSessionsMode = parseStoredSessionsModeFromUrl(url);
      writeJson(req, res, 200, engine.listSessions({ storedSessionsMode }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/terminal/list") {
      const cwd = url.searchParams.get("cwd") ?? undefined;
      const ownerKind = url.searchParams.get("ownerKind") ?? undefined;
      const ownerId = url.searchParams.get("ownerId") ?? undefined;
      if ((ownerKind && !ownerId) || (!ownerKind && ownerId)) {
        writeJson(req, res, 400, { error: "terminal ownerKind and ownerId must be provided together." });
        return;
      }
      if (ownerKind && ownerKind !== "workspace" && ownerKind !== "session") {
        writeJson(req, res, 400, { error: "terminal ownerKind is invalid." });
        return;
      }
      const response: IndependentTerminalListResponse = {
        terminals: engine.listIndependentTerminals({
          ...(cwd ? { cwd } : {}),
          ...(ownerKind && ownerId
            ? { owner: { kind: ownerKind as "workspace" | "session", id: ownerId } }
            : {}),
        }),
      };
      writeJson(req, res, 200, response);
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

    if (req.method === "GET" && pathname === "/api/native-tui/diagnostics") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const includeResolved = url.searchParams.get("includeResolved") === "1";
      const response: ListNativeTuiDiagnosticsResponse = {
        diagnostics: engine.listNativeTuiDiagnostics({
          ...(sessionId ? { sessionId } : {}),
          includeResolved,
        }),
      };
      writeJson(req, res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/api/pty/stats") {
      const response: ListPtyStatsResponse = {
        sessions: engine.listPtyStats(),
      };
      writeJson(req, res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/api/tui-mux/diagnostics") {
      const response: ListTuiMuxDiagnosticsResponse = {
        sessions: await engine.listTuiMuxDiagnostics(),
      };
      writeJson(req, res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/api/council") {
      writeJson(req, res, 200, engine.listCouncils());
      return;
    }

    const councilMessagesMatch = /^\/api\/council\/([^/]+)\/messages$/.exec(pathname);
    if (req.method === "GET" && councilMessagesMatch) {
      const beforeRaw = url.searchParams.get("beforeMessageId");
      const limitRaw = url.searchParams.get("limit");
      const beforeMessageId =
        beforeRaw && Number.isFinite(Number.parseInt(beforeRaw, 10))
          ? Number.parseInt(beforeRaw, 10)
          : undefined;
      const limit = parseQueryLimit(limitRaw);
      writeJson(req, res, 200, engine.readCouncilMessages(decodeURIComponent(councilMessagesMatch[1]!), {
        ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }));
      return;
    }

    const manualProviderModelsMatch = /^\/api\/providers\/([^/]+)\/manual-models$/.exec(pathname);
    if (req.method === "GET" && manualProviderModelsMatch) {
      writeJson(req, res, 200, {
        models: engine.listManualProviderModels(decodeURIComponent(manualProviderModelsMatch[1]!) as ProviderKind),
      });
      return;
    }

    const manualProviderModelOptionMatch =
      /^\/api\/providers\/([^/]+)\/manual-models\/([^/]+)\/options\/([^/]+)$/.exec(pathname);
    if (req.method === "DELETE" && manualProviderModelOptionMatch) {
      const cwd = url.searchParams.get("cwd") ?? undefined;
      writeJson(
        req,
        res,
        200,
        await engine.deleteManualProviderModelOption(
          decodeURIComponent(manualProviderModelOptionMatch[1]!) as ProviderKind,
          decodeURIComponent(manualProviderModelOptionMatch[2]!),
          decodeURIComponent(manualProviderModelOptionMatch[3]!),
          cwd ? { cwd } : {},
        ),
      );
      return;
    }

    const manualProviderModelMatch = /^\/api\/providers\/([^/]+)\/manual-models\/([^/]+)$/.exec(pathname);
    if (req.method === "DELETE" && manualProviderModelMatch) {
      const cwd = url.searchParams.get("cwd") ?? undefined;
      writeJson(
        req,
        res,
        200,
        await engine.deleteManualProviderModel(
          decodeURIComponent(manualProviderModelMatch[1]!) as ProviderKind,
          decodeURIComponent(manualProviderModelMatch[2]!),
          cwd ? { cwd } : {},
        ),
      );
      return;
    }

    const councilAgentTuiMatch =
      /^\/api\/council\/([^/]+)\/agents\/([^/]+)\/tui$/.exec(pathname);
    if (req.method === "GET" && councilAgentTuiMatch) {
      writeJson(
        req,
        res,
        200,
        await engine.getCouncilAgentTui(
          decodeURIComponent(councilAgentTuiMatch[1]!),
          decodeURIComponent(councilAgentTuiMatch[2]!),
        ),
      );
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

    const surfaceMatch = /^\/api\/sessions\/([^/]+)\/tui-surface$/.exec(pathname);
    if (req.method === "GET" && surfaceMatch) {
      writeJson(req, res, 200, engine.getNativeTuiSurface(decodeURIComponent(surfaceMatch[1]!)));
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
      const limit = parseQueryLimit(limitRaw, 100) ?? 100;
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

    if (req.method === "GET" && pathname === "/api/host/file") {
      const filePath = url.searchParams.get("path");
      if (!filePath) {
        writeJson(req, res, 400, { error: "File path is required." });
        return;
      }
      writeJson(req, res, 200, await engine.readHostFile(filePath));
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
      const limit = parseQueryLimit(limitRaw, 100) ?? 100;
      writeJson(req, res, 200, await engine.searchWorkspaceFiles(dir, query, limit));
      return;
    }

    const historyMatch = /^\/api\/sessions\/([^/]+)\/history$/.exec(pathname);
    if (req.method === "GET" && historyMatch) {
      const beforeTs = url.searchParams.get("beforeTs") ?? undefined;
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = parseQueryLimit(limitRaw);
      const detailParam = url.searchParams.get("detail");
      const detail: "full" | "summary" = detailParam === "full" ? "full" : "summary";
      const options = {
        ...(beforeTs !== undefined ? { beforeTs } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
        detail,
      };
      writeJson(req, res, 200, engine.getSessionHistoryPage(historyMatch[1]!, options));
      return;
    }

    const historyDetailMatch = /^\/api\/sessions\/([^/]+)\/history\/detail$/.exec(pathname);
    if (req.method === "GET" && historyDetailMatch) {
      const kind = url.searchParams.get("kind");
      const itemId = url.searchParams.get("itemId");
      if (kind !== "tool_call" && kind !== "observation") {
        writeJson(req, res, 400, { error: "History detail kind must be tool_call or observation." });
        return;
      }
      if (!itemId) {
        writeJson(req, res, 400, { error: "History detail itemId is required." });
        return;
      }
      const detail = engine.getSessionHistoryItemDetail(historyDetailMatch[1]!, { kind, itemId });
      if (detail.events.length === 0) {
        writeJson(req, res, 404, { error: "History detail is not available for this item." });
        return;
      }
      writeJson(req, res, 200, detail);
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
