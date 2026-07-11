import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConversationItemProjection,
  ConversationTurnDetailResponse,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
  ProviderKind,
  ResumeSessionRequest,
  SessionSummary,
  StartSessionRequest,
  StoredSessionRef,
} from "@rah/runtime-protocol";

type Provider = Extract<ProviderKind, "codex" | "opencode" | "claude">;

type SessionResponse = { session: SessionSummary };
type SessionsResponse = {
  sessions: SessionSummary[];
  storedSessions: StoredSessionRef[];
};

type ProviderResult = {
  provider: Provider;
  providerSessionId: string;
  firstRuntimeId: string;
  resumedRuntimeId: string;
  replayRuntimeId: string;
  completedTurns: number;
  interruptedTurns: number;
  toolItems: number;
  statusAuthorities: string[];
  historyBytes: number;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const baseUrl = (process.env.RAH_CONVERSATION_V2_BASE_URL ?? "http://127.0.0.1:43111").replace(/\/$/, "");
const timeoutMs = Number(process.env.RAH_CONVERSATION_V2_TIMEOUT_MS ?? 90_000);
const keepHistory = process.env.RAH_CONVERSATION_V2_KEEP_HISTORY === "1";
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const clientId = `conversation-v2-conformance-${runId}`;

function selectedProviders(): Provider[] {
  const requested = (process.env.RAH_CONVERSATION_V2_PROVIDERS ?? "codex,opencode,claude")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const supported = new Set<Provider>(["codex", "opencode", "claude"]);
  for (const provider of requested) {
    if (!supported.has(provider as Provider)) {
      throw new Error(`Unsupported provider '${provider}'.`);
    }
  }
  return requested as Provider[];
}

async function requestJson<T>(requestPath: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-rah-client": "web",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${requestPath}: ${text}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function waitFor<T>(
  label: string,
  check: () => Promise<T | null | undefined | false>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const started = Date.now();
  const limit = options.timeout ?? timeoutMs;
  let lastError: unknown;
  while (Date.now() - started < limit) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.interval ?? 250));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

function liveBackend(provider: Provider): "native_local_server" | "tui_mux" {
  return provider === "claude" ? "tui_mux" : "native_local_server";
}

function interactiveAttach(): NonNullable<StartSessionRequest["attach"]> {
  return {
    client: {
      id: clientId,
      kind: "api",
      connectionId: clientId,
      cols: 120,
      rows: 40,
    },
    mode: "interactive",
    claimControl: true,
  };
}

function observeAttach(): NonNullable<ResumeSessionRequest["attach"]> {
  return {
    client: {
      id: clientId,
      kind: "api",
      connectionId: clientId,
    },
    mode: "observe",
  };
}

function itemText(item: ConversationItemProjection): string | null {
  if (item.content.kind !== "timeline") {
    return null;
  }
  const timeline = item.content.item;
  return timeline.kind === "user_message" || timeline.kind === "assistant_message"
    ? timeline.text
    : null;
}

function finalText(turn: ConversationTurnProjection): string | null {
  const final = turn.finalAnswerItemId
    ? turn.items.find((item) => item.id === turn.finalAnswerItemId)
    : [...turn.items].reverse().find((item) => item.role === "final");
  return final ? itemText(final) : null;
}

function findTurnByFinal(
  page: ConversationTurnsPageResponse,
  expected: string,
): ConversationTurnProjection | undefined {
  return page.turns.find((turn) => finalText(turn)?.trim() === expected);
}

function findTurnByUserText(
  page: ConversationTurnsPageResponse,
  expectedFragment: string,
): ConversationTurnProjection | undefined {
  return page.turns.find((turn) =>
    turn.items.some(
      (item) => item.role === "user" && itemText(item)?.includes(expectedFragment),
    ),
  );
}

function isToolItem(item: ConversationItemProjection): boolean {
  return item.content.kind === "tool" || item.content.kind === "observation";
}

async function conversationPage(sessionId: string): Promise<ConversationTurnsPageResponse> {
  return requestJson<ConversationTurnsPageResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/conversation/turns?limit=50`,
  );
}

async function detailedTurn(
  sessionId: string,
  turn: ConversationTurnProjection,
): Promise<ConversationTurnProjection> {
  if (turn.items.some(isToolItem) || !turn.providerTurnId) {
    return turn;
  }
  try {
    const query = new URLSearchParams({ providerTurnId: turn.providerTurnId });
    const detail = await requestJson<ConversationTurnDetailResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/conversation/turns/${encodeURIComponent(turn.id)}/detail?${query}`,
    );
    return detail.turn;
  } catch {
    return turn;
  }
}

async function sendInput(sessionId: string, text: string, label: string): Promise<void> {
  await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      text,
      clientMessageId: `${runId}-${label}-message`,
      clientTurnId: `${runId}-${label}-turn`,
    }),
  });
}

async function waitForFinal(sessionId: string, expected: string): Promise<ConversationTurnProjection> {
  return waitFor(`final answer '${expected}'`, async () => {
    const page = await conversationPage(sessionId);
    const turn = findTurnByFinal(page, expected);
    return turn?.status === "completed" ? turn : null;
  });
}

async function closeSession(sessionId: string): Promise<void> {
  await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/close`, {
    method: "POST",
    body: JSON.stringify({ clientId }),
  });
}

async function removeStoredSession(provider: Provider, providerSessionId: string): Promise<void> {
  await requestJson("/api/history/sessions/remove?stored=none", {
    method: "POST",
    body: JSON.stringify({ provider, providerSessionId }),
  });
}

async function waitForStoredSession(
  provider: Provider,
  providerSessionId: string,
): Promise<StoredSessionRef> {
  return waitFor(`${provider} stored session`, async () => {
    const response = await requestJson<SessionsResponse>("/api/sessions?stored=all");
    return response.storedSessions.find(
      (item) => item.provider === provider && item.providerSessionId === providerSessionId,
    );
  });
}

async function interruptTurn(
  sessionId: string,
  marker: string,
): Promise<ConversationTurnProjection> {
  await sendInput(
    sessionId,
    `Use your shell tool to run \`sleep 20\`. Do not modify files. This is interrupt probe ${marker}. After the command finishes, reply with exactly ${marker}_UNEXPECTED.`,
    `${marker}-interrupt`,
  );
  const active = await waitFor(`${marker} active turn`, async () => {
    const turn = findTurnByUserText(await conversationPage(sessionId), marker);
    return turn?.status === "in_progress" &&
      turn.items.some((item) => item.role === "process" || isToolItem(item))
      ? turn
      : null;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST",
    body: JSON.stringify({ clientId }),
  });
  return waitFor(`${marker} interrupted turn`, async () => {
    const page = await conversationPage(sessionId);
    const turn = page.turns.find((candidate) => candidate.id === active.id) ??
      findTurnByUserText(page, marker);
    return turn && turn.status !== "in_progress" ? turn : null;
  }, { timeout: 30_000 });
}

async function runProvider(provider: Provider): Promise<ProviderResult> {
  const managedSessionIds = new Set<string>();
  let providerSessionId: string | undefined;
  const prefix = `RAH_${provider.toUpperCase()}_CONFORMANCE_${runId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  let firstRuntimeId = "";
  let resumedRuntimeId = "";
  let replayRuntimeId = "";
  let observedToolItems = 0;
  try {
    const started = await requestJson<SessionResponse>("/api/sessions/start", {
      method: "POST",
      body: JSON.stringify({
        provider,
        cwd: repoRoot,
        liveBackend: liveBackend(provider),
        title: `${prefix} smoke`,
        attach: interactiveAttach(),
      } satisfies StartSessionRequest),
    });
    firstRuntimeId = started.session.session.id;
    providerSessionId = started.session.session.providerSessionId;
    if (!providerSessionId) {
      throw new Error(`${provider} did not bind a provider session id.`);
    }
    managedSessionIds.add(firstRuntimeId);

    const firstMarker = `${prefix}_TURN1_OK`;
    await sendInput(
      firstRuntimeId,
      `Reply with exactly ${firstMarker} and do not use tools or modify files.`,
      "turn1",
    );
    await waitForFinal(firstRuntimeId, firstMarker);

    const toolMarker = `${prefix}_TOOL_OK`;
    await sendInput(
      firstRuntimeId,
      `Use your shell tool to run \`pwd\` once. Do not modify files. Then reply with exactly ${toolMarker}.`,
      "tool",
    );
    const toolTurn = await waitForFinal(firstRuntimeId, toolMarker);
    const hydratedToolTurn = await detailedTurn(firstRuntimeId, toolTurn);
    observedToolItems = hydratedToolTurn.items.filter(isToolItem).length;
    if (observedToolItems === 0) {
      throw new Error(`${provider} completed the tool probe without a canonical tool/observation item.`);
    }

    await closeSession(firstRuntimeId);
    managedSessionIds.delete(firstRuntimeId);
    await waitForStoredSession(provider, providerSessionId);

    const resumed = await requestJson<SessionResponse>("/api/sessions/resume", {
      method: "POST",
      body: JSON.stringify({
        provider,
        providerSessionId,
        cwd: repoRoot,
        liveBackend: liveBackend(provider),
        historyReplay: "skip",
        attach: interactiveAttach(),
      } satisfies ResumeSessionRequest),
    });
    resumedRuntimeId = resumed.session.session.id;
    managedSessionIds.add(resumedRuntimeId);

    const resumedMarker = `${prefix}_RESUME_OK`;
    await sendInput(
      resumedRuntimeId,
      `Reply with exactly ${resumedMarker} and do not use tools or modify files.`,
      "resume",
    );
    await waitForFinal(resumedRuntimeId, resumedMarker);

    const interruptMarker = `${prefix}_INTERRUPT`;
    const interrupted = await interruptTurn(resumedRuntimeId, interruptMarker);
    if (interrupted.status !== "interrupted") {
      throw new Error(`${provider} interrupt ended as '${interrupted.status}', expected 'interrupted'.`);
    }

    const recoveryMarker = `${prefix}_RECOVERY_OK`;
    await sendInput(
      resumedRuntimeId,
      `Reply with exactly ${recoveryMarker} and do not use tools or modify files.`,
      "recovery",
    );
    await waitForFinal(resumedRuntimeId, recoveryMarker);

    await closeSession(resumedRuntimeId);
    managedSessionIds.delete(resumedRuntimeId);
    const stored = await waitForStoredSession(provider, providerSessionId);

    const replay = await requestJson<SessionResponse>("/api/sessions/resume", {
      method: "POST",
      body: JSON.stringify({
        provider,
        providerSessionId,
        cwd: repoRoot,
        preferStoredReplay: true,
        attach: observeAttach(),
      } satisfies ResumeSessionRequest),
    });
    replayRuntimeId = replay.session.session.id;
    managedSessionIds.add(replayRuntimeId);

    const replayPage = await waitFor(`${provider} replay projection`, async () => {
      const page = await conversationPage(replayRuntimeId);
      const required = [firstMarker, toolMarker, resumedMarker, recoveryMarker];
      return required.every((marker) => findTurnByFinal(page, marker)) ? page : null;
    });
    const emptyTurns = replayPage.turns.filter((turn) => turn.items.length === 0);
    if (emptyTurns.length > 0) {
      throw new Error(`${provider} replay contains ${emptyTurns.length} empty canonical turn(s).`);
    }
    const interruptedTurns = replayPage.turns.filter((turn) => turn.status === "interrupted");
    if (interruptedTurns.length === 0) {
      throw new Error(`${provider} replay did not preserve the interrupted turn.`);
    }

    return {
      provider,
      providerSessionId,
      firstRuntimeId,
      resumedRuntimeId,
      replayRuntimeId,
      completedTurns: replayPage.turns.filter((turn) => turn.status === "completed").length,
      interruptedTurns: interruptedTurns.length,
      toolItems: observedToolItems,
      statusAuthorities: [...new Set(replayPage.turns.map((turn) => turn.statusAuthority))],
      historyBytes: stored.historyMeta?.bytes ?? 0,
    };
  } finally {
    for (const sessionId of managedSessionIds) {
      try {
        await closeSession(sessionId);
      } catch {
        // Cleanup continues with the remaining owned sessions.
      }
    }
    if (!keepHistory && providerSessionId) {
      try {
        await removeStoredSession(provider, providerSessionId);
      } catch {
        // Report the primary conformance failure instead of masking it with cleanup.
      }
    }
  }
}

async function main(): Promise<void> {
  await requestJson("/api/runtime");
  const results: ProviderResult[] = [];
  for (const provider of selectedProviders()) {
    process.stderr.write(`[conversation-v2] testing ${provider}\n`);
    results.push(await runProvider(provider));
  }
  process.stdout.write(`${JSON.stringify({ ok: true, runId, baseUrl, results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
