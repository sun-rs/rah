import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AttachmentPreviewResponse,
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
  UploadAttachmentResponse,
} from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import type { WorkbenchNoticePreferencesStore } from "./workbench-notice-preferences";
import { applyCorsHeaders, validateApiRequest } from "./http-server-cors";
import {
  type JsonHandler,
  readBinaryBody,
  readJsonBody,
  requestErrorStatus,
  writeHtml,
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
  parseCouncilMcpReadyRequest,
  parseCouncilPostMessageRequest,
  parseCreateCouncilRequest,
  parseDetachSessionRequest,
  parseDeleteQueuedInputRequest,
  parseGitFileActionRequest,
  parseGitHunkActionRequest,
  parseForkSessionRequest,
  parseIndependentTerminalStartRequest,
  parseInterruptSessionRequest,
  parseNativeTuiSurfaceClaimRequest,
  parseNativeTuiClientCloseRequest,
  parseNativeTuiSurfaceReleaseRequest,
  parsePermissionResponseRequest,
  parseReleaseControlRequest,
  parseRenameCouncilRequest,
  parseRenameSessionRequest,
  parseReorderQueuedInputRequest,
  parseResumeSessionRequest,
  parseSessionInputRequest,
  parseSetInputQueuePolicyRequest,
  parseSetSessionModeRequest,
  parseSetSessionModelRequest,
  parseSteerQueuedInputRequest,
  parseStartDebugScenarioRequest,
  parseStartSessionRequest,
  parseStoredSessionRemoveRequest,
  parseStoredSessionArchiveRequest,
  parseUpdateQueuedInputRequest,
  parseUpdateWorkbenchPinnedItemRequest,
  parseWorkspaceDirectoryRequest,
} from "./http-server-request-validation";
import { serveClientApp } from "./http-server-static";
import {
  isLocalMachineRemoteAddress,
  resolveImagePreviewModeForPeer,
} from "./http-server-client-address";
import { writeHostClipboard } from "./host-clipboard";
import { DeviceAuthManager, handleDeviceAuthRequest } from "./device-auth";
import {
  MAX_DEVICE_ATTACHMENT_BYTES,
  resolveDeviceAttachment,
  saveDeviceAttachment,
} from "./device-attachments";
import {
  buildVisualArtifactDocument,
  visualArtifactContentSecurityPolicy,
} from "./visual-artifact-document";

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

function parseStoredSessionsModeFromUrl(url: URL): "all" | "cached" | "recent" {
  const mode = url.searchParams.get("storedSessions");
  return mode === "all" || mode === "cached" ? mode : "recent";
}

function parseStoredSessionsModeFromRequest(req: IncomingMessage): "all" | "cached" | "recent" {
  return parseStoredSessionsModeFromUrl(new URL(req.url ?? "", "http://127.0.0.1"));
}

function parseRevisionFromUrl(url: URL): number {
  const raw = url.searchParams.get("since");
  if (!raw) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseImagePreviewModeFromRequest(
  req: IncomingMessage,
  url: URL,
): "bounded" | "full" {
  const clientHint = url.searchParams.get("imagePreviewClient");
  return resolveImagePreviewModeForPeer({
    hostname: hostnameFromHostHeader(req.headers.host),
    remoteAddress: req.socket.remoteAddress,
    ...(clientHint ? { clientHint } : {}),
  });
}

function hostnameFromHostHeader(host: string | undefined): string {
  const trimmed = host?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(":")[0] ?? trimmed;
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
      pattern: /^\/api\/sessions\/([^/]+)\/fork$/,
      handler: async (req, res, match, body) => {
        const result = await engine.forkSession(
          match[1]!,
          parseForkSessionRequest(body),
        );
        writeJson(req, res, 200, result);
      },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)\/attach$/,
      handler: async (req, res, match, body) => {
        const result = await engine.attachSession(match[1]!, parseAttachSessionRequest(body));
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
          await engine.addWorkspace(parseWorkspaceDirectoryRequest(body).dir, {
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
          await engine.selectWorkspace(parseWorkspaceDirectoryRequest(body).dir, {
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
          await engine.removeWorkspace(parseWorkspaceDirectoryRequest(body).dir, {
            storedSessionsMode: parseStoredSessionsModeFromRequest(req),
          }),
        );
      },
    },
    {
      pattern: /^\/api\/workbench\/pins$/,
      handler: async (req, res, _match, body) => {
        const request = parseUpdateWorkbenchPinnedItemRequest(body);
        writeJson(
          req,
          res,
          200,
          engine.setWorkbenchPinnedItem(
            request.workspaceDir,
            request.itemKey,
            request.pinned,
            { storedSessionsMode: parseStoredSessionsModeFromRequest(req) },
          ),
        );
      },
    },
    {
      pattern: /^\/api\/history\/sessions\/archive$/,
      handler: async (req, res, _match, body) => {
        const request = parseStoredSessionArchiveRequest(body);
        writeJson(
          req,
          res,
          200,
          await engine.archiveStoredSession(request.provider, request.providerSessionId, {
            storedSessionsMode: parseStoredSessionsModeFromRequest(req),
            ...(request.runtimeSessionId
              ? {
                  runtimeSessionId: request.runtimeSessionId,
                  clientId: request.clientId!,
                }
              : {}),
          }),
        );
      },
    },
    {
      pattern: /^\/api\/history\/sessions\/restore$/,
      handler: async (req, res, _match, body) => {
        const request = parseStoredSessionRemoveRequest(body);
        writeJson(
          req,
          res,
          200,
          await engine.restoreStoredSession(request.provider, request.providerSessionId, {
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
          await engine.removeStoredSession(request.provider, request.providerSessionId, {
            storedSessionsMode: parseStoredSessionsModeFromRequest(req),
          }),
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
      pattern: /^\/api\/council\/mcp-ready$/,
      handler: async (req, res, _match, body) => {
        const request = parseCouncilMcpReadyRequest(body);
        engine.markCouncilMcpReady(request.councilId, request.actorId);
        writeJson(req, res, 200, { ok: true });
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
  noticePreferences: WorkbenchNoticePreferencesStore;
  req: IncomingMessage;
  res: ServerResponse;
  runtimeIdentity?: RuntimeIdentityResponse | undefined;
  auth?: DeviceAuthManager | undefined;
}): Promise<void> {
  const { engine, postRoutes, noticePreferences, req, res, runtimeIdentity, auth } = args;
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

    if (auth && await handleDeviceAuthRequest({ auth, req, res, url })) {
      return;
    }

    if (auth && pathname.startsWith("/api/") && !auth.authenticate(req)) {
      writeJson(req, res, 401, { error: "This device is not trusted by RAH." });
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

    if (
      req.method === "GET" &&
      pathname === "/api/workbench/notices/runtime-compatibility"
    ) {
      writeJson(req, res, 200, noticePreferences.runtimeCompatibilityState());
      return;
    }

    if (
      req.method === "PUT" &&
      pathname === "/api/workbench/notices/runtime-compatibility/mute"
    ) {
      writeJson(req, res, 200, noticePreferences.muteRuntimeCompatibilityForToday());
      return;
    }

    if (req.method === "POST" && pathname === "/api/attachments") {
      const rawName = req.headers["x-rah-file-name"];
      if (Array.isArray(rawName)) {
        throw new Error("Bad Request: attachment file name is invalid.");
      }
      let name: string | undefined;
      if (rawName) {
        try {
          name = decodeURIComponent(rawName);
        } catch {
          throw new Error("Bad Request: attachment file name is invalid.");
        }
      }
      const contentType = req.headers["content-type"];
      const mediaType = Array.isArray(contentType) ? contentType[0] : contentType;
      const attachment = await saveDeviceAttachment({
        bytes: await readBinaryBody(req, MAX_DEVICE_ATTACHMENT_BYTES),
        ...(name ? { name } : {}),
        ...(mediaType ? { mediaType } : {}),
      });
      const response: UploadAttachmentResponse = { attachment };
      writeJson(req, res, 201, response);
      return;
    }

    const attachmentMatch = /^\/api\/attachments\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && attachmentMatch) {
      const resolved = await resolveDeviceAttachment(
        decodeURIComponent(attachmentMatch[1]!),
      );
      const { path, ...attachment } = resolved;
      const response: AttachmentPreviewResponse = {
        attachment,
        file: await engine.readHostFile(path, {
          imagePreviewMode: parseImagePreviewModeFromRequest(req, url),
        }),
      };
      writeJson(req, res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/api/sessions") {
      const storedSessionsMode = parseStoredSessionsModeFromUrl(url);
      writeJson(req, res, 200, await engine.listSessionsForRequest({ storedSessionsMode }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/sessions/stored-delta") {
      writeJson(req, res, 200, engine.getStoredSessionsDelta(parseRevisionFromUrl(url)));
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
      const includeHealth = url.searchParams.get("health") !== "0";
      const requestedProvider = url.searchParams.get("provider");
      if (
        requestedProvider !== null &&
        requestedProvider !== "codex" &&
        requestedProvider !== "claude" &&
        requestedProvider !== "opencode"
      ) {
        writeJson(req, res, 400, { error: `Unsupported provider: ${requestedProvider}` });
        return;
      }
      const response: ListProvidersResponse = {
        providers: await engine.listProviderDiagnostics({
          forceRefresh,
          includeHealth,
          ...(requestedProvider ? { provider: requestedProvider } : {}),
        }),
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

    const queuedInputMatch =
      /^\/api\/sessions\/([^/]+)\/input\/([^/]+)$/.exec(pathname);
    const queuedInputPositionMatch =
      /^\/api\/sessions\/([^/]+)\/input\/([^/]+)\/position$/.exec(pathname);
    if (req.method === "PATCH" && queuedInputPositionMatch) {
      const body = await readJsonBody(req);
      writeJson(req, res, 200, {
        session: engine.reorderQueuedInput(
          decodeURIComponent(queuedInputPositionMatch[1]!),
          decodeURIComponent(queuedInputPositionMatch[2]!),
          parseReorderQueuedInputRequest(body),
        ),
      });
      return;
    }
    const queuedInputSteerMatch =
      /^\/api\/sessions\/([^/]+)\/input\/([^/]+)\/steer$/.exec(pathname);
    if (req.method === "POST" && queuedInputSteerMatch) {
      const body = await readJsonBody(req);
      writeJson(req, res, 200, {
        session: await engine.steerQueuedInput(
          decodeURIComponent(queuedInputSteerMatch[1]!),
          decodeURIComponent(queuedInputSteerMatch[2]!),
          parseSteerQueuedInputRequest(body),
        ),
      });
      return;
    }
    if (req.method === "PATCH" && queuedInputMatch) {
      const body = await readJsonBody(req);
      writeJson(
        req,
        res,
        200,
        {
          session: engine.updateQueuedInput(
            decodeURIComponent(queuedInputMatch[1]!),
            decodeURIComponent(queuedInputMatch[2]!),
            parseUpdateQueuedInputRequest(body),
          ),
        },
      );
      return;
    }

    const inputQueuePolicyMatch =
      /^\/api\/sessions\/([^/]+)\/input-policy$/.exec(pathname);
    if (req.method === "PATCH" && inputQueuePolicyMatch) {
      const body = await readJsonBody(req);
      writeJson(req, res, 200, {
        session: engine.setInputQueuePolicy(
          decodeURIComponent(inputQueuePolicyMatch[1]!),
          parseSetInputQueuePolicyRequest(body),
        ),
      });
      return;
    }
    if (req.method === "DELETE" && queuedInputMatch) {
      const body = await readJsonBody(req);
      writeJson(
        req,
        res,
        200,
        {
          session: engine.deleteQueuedInput(
            decodeURIComponent(queuedInputMatch[1]!),
            decodeURIComponent(queuedInputMatch[2]!),
            parseDeleteQueuedInputRequest(body),
          ),
        },
      );
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
        await engine.getWorkspaceSnapshot(workspaceMatch[1]!, {
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
        await engine.getWorkspaceSnapshot(filesMatch[1]!, {
          ...(scopeRoot ? { scopeRoot } : {}),
        }),
      );
      return;
    }

    const gitStatusMatch = /^\/api\/sessions\/([^/]+)\/git-status$/.exec(pathname);
    if (req.method === "GET" && gitStatusMatch) {
      const scopeRoot = url.searchParams.get("scopeRoot") ?? undefined;
      const baseBranch = url.searchParams.get("baseBranch") ?? undefined;
      writeJson(
        req,
        res,
        200,
        await engine.getGitStatus(gitStatusMatch[1]!, {
          ...(scopeRoot ? { scopeRoot } : {}),
          ...(baseBranch ? { baseBranch } : {}),
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
      const baseBranch = url.searchParams.get("baseBranch") ?? undefined;
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
          ...(baseBranch ? { baseBranch } : {}),
        }),
      );
      return;
    }

    const turnFileChangesMatch =
      /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/file-changes$/.exec(pathname);
    if (req.method === "GET" && turnFileChangesMatch) {
      writeJson(
        req,
        res,
        200,
        await engine.getTurnFileChanges(
          decodeURIComponent(turnFileChangesMatch[1]!),
          decodeURIComponent(turnFileChangesMatch[2]!),
        ),
      );
      return;
    }

    const turnFileDiffMatch =
      /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/file-diff$/.exec(pathname);
    if (req.method === "GET" && turnFileDiffMatch) {
      const diffPath = url.searchParams.get("path");
      if (!diffPath) {
        writeJson(req, res, 400, { error: "File path is required." });
        return;
      }
      writeJson(
        req,
        res,
        200,
        await engine.getTurnFileDiff(
          decodeURIComponent(turnFileDiffMatch[1]!),
          decodeURIComponent(turnFileDiffMatch[2]!),
          diffPath,
        ),
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
          imagePreviewMode: parseImagePreviewModeFromRequest(req, url),
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
      const baseBranch = url.searchParams.get("baseBranch") ?? undefined;
      writeJson(
        req,
        res,
        200,
        await engine.getWorkspaceGitStatus(dir, {
          ...(baseBranch ? { baseBranch } : {}),
        }),
      );
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
      const baseBranch = url.searchParams.get("baseBranch") ?? undefined;
      writeJson(
        req,
        res,
        200,
        await engine.getWorkspaceGitDiff(dir, diffPath, {
          ...(staged !== null ? { staged: staged === "true" } : {}),
          ...(ignoreWhitespace !== null
            ? { ignoreWhitespace: ignoreWhitespace === "true" }
            : {}),
          ...(baseBranch ? { baseBranch } : {}),
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
      writeJson(
        req,
        res,
        200,
        await engine.readWorkspaceFile(dir, filePath, {
          imagePreviewMode: parseImagePreviewModeFromRequest(req, url),
        }),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/api/host/file") {
      const filePath = url.searchParams.get("path");
      if (!filePath) {
        writeJson(req, res, 400, { error: "File path is required." });
        return;
      }
      writeJson(
        req,
        res,
        200,
        await engine.readHostFile(filePath, {
          imagePreviewMode: parseImagePreviewModeFromRequest(req, url),
        }),
      );
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

    const turnDirectoryMatch = /^\/api\/sessions\/([^/]+)\/conversation\/directory$/.exec(
      pathname,
    );
    if (req.method === "GET" && turnDirectoryMatch) {
      writeJson(
        req,
        res,
        200,
        await engine.getSessionConversationDirectory(turnDirectoryMatch[1]!),
      );
      return;
    }

    const conversationTurnsMatch = /^\/api\/sessions\/([^/]+)\/conversation\/turns$/.exec(
      pathname,
    );
    if (req.method === "GET" && conversationTurnsMatch) {
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = parseQueryLimit(url.searchParams.get("limit"), 20) ?? 20;
      const liveOnly = url.searchParams.get("liveOnly") === "true";
      writeJson(
        req,
        res,
        200,
        await engine.getSessionConversationTurns(conversationTurnsMatch[1]!, {
          ...(cursor ? { cursor } : {}),
          limit,
          ...(liveOnly ? { liveOnly: true } : {}),
        }),
      );
      return;
    }

    const conversationSourceRevisionMatch =
      /^\/api\/sessions\/([^/]+)\/conversation\/source-revision$/.exec(pathname);
    if (req.method === "GET" && conversationSourceRevisionMatch) {
      writeJson(
        req,
        res,
        200,
        await engine.getSessionConversationSourceRevision(
          conversationSourceRevisionMatch[1]!,
        ),
      );
      return;
    }

    const conversationVisualArtifactMatch =
      /^\/api\/sessions\/([^/]+)\/conversation\/visual-artifacts\/([^/]+)$/.exec(
        pathname,
      );
    if (req.method === "GET" && conversationVisualArtifactMatch) {
      let artifactId: string;
      try {
        artifactId = decodeURIComponent(conversationVisualArtifactMatch[2]!);
      } catch {
        writeJson(req, res, 400, {
          error: "Conversation visual artifact id is invalid.",
        });
        return;
      }
      const artifact = await engine.getSessionConversationVisualArtifact(
        conversationVisualArtifactMatch[1]!,
        artifactId,
      );
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      writeHtml(
        req,
        res,
        200,
        buildVisualArtifactDocument({
          fragment: artifact.fragment,
          theme,
        }),
        {
          contentSecurityPolicy: visualArtifactContentSecurityPolicy(),
        },
      );
      return;
    }

    const conversationVisualArtifactSourceMatch =
      /^\/api\/sessions\/([^/]+)\/conversation\/visual-artifacts\/([^/]+)\/source$/.exec(
        pathname,
      );
    if (req.method === "GET" && conversationVisualArtifactSourceMatch) {
      let artifactId: string;
      try {
        artifactId = decodeURIComponent(conversationVisualArtifactSourceMatch[2]!);
      } catch {
        writeJson(req, res, 400, {
          error: "Conversation visual artifact id is invalid.",
        });
        return;
      }
      writeJson(
        req,
        res,
        200,
        await engine.getSessionConversationVisualArtifactSource(
          conversationVisualArtifactSourceMatch[1]!,
          artifactId,
        ),
      );
      return;
    }

    const conversationResourcesMatch =
      /^\/api\/sessions\/([^/]+)\/conversation\/resources$/.exec(pathname);
    if (req.method === "GET" && conversationResourcesMatch) {
      writeJson(
        req,
        res,
        200,
        await engine.getSessionConversationResourceIndex(conversationResourcesMatch[1]!, {
          ...(url.searchParams.get("refresh") === "true" ? { refresh: true } : {}),
        }),
      );
      return;
    }

    const conversationTurnDetailMatch =
      /^\/api\/sessions\/([^/]+)\/conversation\/turns\/([^/]+)\/detail$/.exec(pathname);
    if (req.method === "GET" && conversationTurnDetailMatch) {
      let turnId: string;
      try {
        turnId = decodeURIComponent(conversationTurnDetailMatch[2]!);
      } catch {
        writeJson(req, res, 400, { error: "Conversation turn id is invalid." });
        return;
      }
      const providerTurnId = url.searchParams.get("providerTurnId");
      if (!providerTurnId) {
        writeJson(req, res, 400, {
          error: "Conversation turn detail requires providerTurnId.",
        });
        return;
      }
      const detail = await engine.getSessionConversationTurnDetail(
        conversationTurnDetailMatch[1]!,
        { turnId, providerTurnId },
      );
      if (!detail) {
        writeJson(req, res, 404, { error: "Conversation turn detail is not available." });
        return;
      }
      writeJson(req, res, 200, detail);
      return;
    }

    const conversationItemDetailMatch =
      /^\/api\/sessions\/([^/]+)\/conversation\/items\/([^/]+)\/detail$/.exec(pathname);
    if (req.method === "GET" && conversationItemDetailMatch) {
      let itemId: string;
      try {
        itemId = decodeURIComponent(conversationItemDetailMatch[2]!);
      } catch {
        writeJson(req, res, 400, { error: "Conversation item id is invalid." });
        return;
      }
      const providerTurnId = url.searchParams.get("providerTurnId");
      const providerItemId = url.searchParams.get("providerItemId");
      if (!providerTurnId || !providerItemId) {
        writeJson(req, res, 400, {
          error: "Conversation detail requires providerTurnId and providerItemId.",
        });
        return;
      }
      const detail = await engine.getSessionConversationItemDetail(
        conversationItemDetailMatch[1]!,
        {
          itemId,
          ...(url.searchParams.get("turnId")
            ? { turnId: url.searchParams.get("turnId")! }
            : {}),
          providerTurnId,
          providerItemId,
        },
      );
      if (!detail) {
        writeJson(req, res, 404, { error: "Conversation item detail is not available." });
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
