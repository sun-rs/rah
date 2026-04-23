import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const baseUrl = process.env.RAH_BASE_URL ?? "http://127.0.0.1:43111";

type SessionSummary = {
  session: {
    id: string;
    provider: string;
    providerSessionId?: string;
    runtimeState: string;
  };
  attachedClients: Array<{ id: string }>;
  controlLease: { holderClientId?: string };
};

type EventBatch = {
  events?: Array<{
    sessionId: string;
    turnId?: string;
    type: string;
    payload: Record<string, unknown>;
  }>;
};

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} for ${path}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function waitForIdle(sessionId: string, timeoutMs = 240_000) {
  const started = Date.now();
  let last: SessionSummary | null = null;
  while (Date.now() - started < timeoutMs) {
    last = (await requestJson(`/api/sessions/${sessionId}`)).session as SessionSummary;
    if (["idle", "failed", "stopped"].includes(last.session.runtimeState)) {
      return last;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${sessionId}; last=${JSON.stringify(last)}`);
}

async function closeSession(sessionId: string, clientId: string) {
  try {
    await requestJson(`/api/sessions/${sessionId}/close`, {
      method: "POST",
      body: JSON.stringify({ clientId }),
    });
  } catch {
    // best effort cleanup
  }
}

async function cleanupLiveKimiSessions() {
  const sessions = ((await requestJson("/api/sessions")) as { sessions: SessionSummary[] }).sessions;
  for (const summary of sessions) {
    if (summary.session.provider !== "kimi") {
      continue;
    }
    const clientId =
      summary.controlLease.holderClientId ??
      summary.attachedClients[0]?.id ??
      "kimi-flow-smoke-cleanup";
    await closeSession(summary.session.id, clientId);
  }
}

async function main() {
  await cleanupLiveKimiSessions();

  const clientId = `kimi-flow-smoke-${Date.now()}`;
  const workdir = await mkdtemp(path.join(os.tmpdir(), "rah-kimi-flow-"));
  await writeFile(`${workdir}/alpha.txt`, "ALPHA-KIMI\n", "utf8");

  const socketMessages: EventBatch[] = [];
  const ws = new WebSocket(baseUrl.replace("http", "ws") + "/api/events");
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Failed to open /api/events websocket"));
  });
  ws.onmessage = (event) => {
    try {
      socketMessages.push(JSON.parse(String(event.data)) as EventBatch);
    } catch {
      // ignore malformed test data
    }
  };

  let liveSessionId: string | null = null;
  let replaySessionId: string | null = null;
  let resumedSessionId: string | null = null;

  try {
    const started = await requestJson("/api/sessions/start", {
      method: "POST",
      body: JSON.stringify({
        provider: "kimi",
        cwd: workdir,
        attach: {
          client: { id: clientId, kind: "web", connectionId: clientId },
          mode: "interactive",
          claimControl: true,
        },
      }),
    });
    liveSessionId = started.session.session.id;

    const firstPrompt =
      "请读取 alpha.txt 的内容，然后创建 beta.txt，文件内容必须严格为 BETA-KIMI。最后只用一句中文回答。";
    await requestJson(`/api/sessions/${liveSessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ clientId, text: firstPrompt }),
    });

    let firstPermissionRequestId: string | null = null;
    const approvalDeadline = Date.now() + 120_000;
    while (Date.now() < approvalDeadline && firstPermissionRequestId === null) {
      for (const batch of socketMessages) {
        for (const event of batch.events ?? []) {
          if (
            event.sessionId === liveSessionId &&
            event.type === "permission.requested" &&
            typeof event.payload?.request === "object"
          ) {
            const request = event.payload.request as Record<string, unknown>;
            if (typeof request.id === "string") {
              firstPermissionRequestId = request.id;
              break;
            }
          }
        }
        if (firstPermissionRequestId) {
          break;
        }
      }
      if (firstPermissionRequestId === null) {
        await sleep(500);
      }
    }
    if (firstPermissionRequestId === null) {
      throw new Error("Timed out waiting for first Kimi permission request.");
    }

    await requestJson(
      `/api/sessions/${liveSessionId}/permissions/${encodeURIComponent(firstPermissionRequestId)}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          behavior: "allow",
          selectedActionId: "approve",
          decision: "approved",
        }),
      },
    );

    const firstDone = await waitForIdle(liveSessionId);
    const providerSessionId = firstDone.session.providerSessionId;
    if (!providerSessionId) {
      throw new Error("Kimi live session never published a providerSessionId.");
    }

    const betaContent = await readFile(`${workdir}/beta.txt`, "utf8");
    if (betaContent !== "BETA-KIMI") {
      throw new Error(`Unexpected beta.txt content: ${JSON.stringify(betaContent)}`);
    }

    await closeSession(liveSessionId, clientId);
    liveSessionId = null;

    const listed = await requestJson("/api/sessions") as {
      recentSessions: Array<Record<string, unknown>>;
      storedSessions: Array<Record<string, unknown>>;
    };
    const recent = listed.recentSessions.filter(
      (item) => item.provider === "kimi" && item.providerSessionId === providerSessionId,
    );
    const stored = listed.storedSessions.filter(
      (item) => item.provider === "kimi" && item.providerSessionId === providerSessionId,
    );
    if (recent.length === 0 || stored.length === 0) {
      throw new Error("Closed Kimi session did not appear in recent/stored history.");
    }

    const replay = await requestJson("/api/sessions/resume", {
      method: "POST",
      body: JSON.stringify({
        provider: "kimi",
        providerSessionId,
        cwd: workdir,
        preferStoredReplay: true,
        attach: {
          client: { id: clientId, kind: "web", connectionId: clientId },
          mode: "observe",
        },
      }),
    });
    replaySessionId = replay.session.session.id;
    if (replay.session.session.capabilities.steerInput !== false) {
      throw new Error("Kimi replay session should be read-only.");
    }

    const history = await requestJson(`/api/sessions/${replaySessionId}/history?limit=1000`) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const assistantTexts = history.events
      .filter(
        (event) =>
          event.type === "timeline.item.added" &&
          (event.payload.item as { kind?: string }).kind === "assistant_message",
      )
      .map((event) => (event.payload.item as { text?: string }).text)
      .filter((value): value is string => typeof value === "string");
    if (assistantTexts.length === 0) {
      throw new Error("Kimi replay history did not include assistant output.");
    }

    await closeSession(replaySessionId, clientId);
    replaySessionId = null;

    const resumed = await requestJson("/api/sessions/resume", {
      method: "POST",
      body: JSON.stringify({
        provider: "kimi",
        providerSessionId,
        cwd: workdir,
        preferStoredReplay: false,
        historyReplay: "skip",
        attach: {
          client: { id: clientId, kind: "web", connectionId: clientId },
          mode: "interactive",
          claimControl: true,
        },
      }),
    });
    resumedSessionId = resumed.session.session.id;
    if (resumed.session.session.capabilities.steerInput !== true) {
      throw new Error("Kimi resumed live session should be interactive.");
    }

    const secondPrompt =
      "请读取 beta.txt 的内容，然后创建 gamma.txt，文件内容必须严格为 GAMMA-KIMI。最后只用一句中文回答。";
    await requestJson(`/api/sessions/${resumedSessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ clientId, text: secondPrompt }),
    });

    let secondPermissionRequestId: string | null = null;
    const secondApprovalDeadline = Date.now() + 120_000;
    while (Date.now() < secondApprovalDeadline && secondPermissionRequestId === null) {
      for (const batch of socketMessages) {
        for (const event of batch.events ?? []) {
          if (
            event.sessionId === resumedSessionId &&
            event.type === "permission.requested" &&
            typeof event.payload?.request === "object"
          ) {
            const request = event.payload.request as Record<string, unknown>;
            if (typeof request.id === "string") {
              secondPermissionRequestId = request.id;
              break;
            }
          }
        }
        if (secondPermissionRequestId) {
          break;
        }
      }
      if (secondPermissionRequestId === null) {
        await sleep(500);
      }
    }
    if (secondPermissionRequestId === null) {
      throw new Error("Timed out waiting for second Kimi permission request.");
    }

    await requestJson(
      `/api/sessions/${resumedSessionId}/permissions/${encodeURIComponent(secondPermissionRequestId)}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          behavior: "allow",
          selectedActionId: "approve",
          decision: "approved",
        }),
      },
    );

    const secondDone = await waitForIdle(resumedSessionId);
    if (secondDone.session.providerSessionId !== providerSessionId) {
      throw new Error("Kimi live resume changed providerSessionId unexpectedly.");
    }

    const gammaContent = await readFile(`${workdir}/gamma.txt`, "utf8");
    if (gammaContent !== "GAMMA-KIMI") {
      throw new Error(`Unexpected gamma.txt content: ${JSON.stringify(gammaContent)}`);
    }

    console.log(
      JSON.stringify(
        {
          baseUrl,
          cwd: workdir,
          providerSessionId,
          recentCount: recent.length,
          storedCount: stored.length,
          historyAssistantTexts: assistantTexts.slice(0, 5),
          betaContent,
          gammaContent,
        },
        null,
        2,
      ),
    );
  } finally {
    if (resumedSessionId) {
      await closeSession(resumedSessionId, clientId);
    }
    if (replaySessionId) {
      await closeSession(replaySessionId, clientId);
    }
    if (liveSessionId) {
      await closeSession(liveSessionId, clientId);
    }
    ws.close();
    await rm(workdir, { recursive: true, force: true });
  }
}

await main();
