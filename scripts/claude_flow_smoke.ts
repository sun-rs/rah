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
    await Bun.sleep(1000);
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

async function cleanupLiveClaudeSessions() {
  const sessions = ((await requestJson("/api/sessions")) as { sessions: SessionSummary[] }).sessions;
  for (const summary of sessions) {
    if (summary.session.provider !== "claude") {
      continue;
    }
    const clientId =
      summary.controlLease.holderClientId ??
      summary.attachedClients[0]?.id ??
      "claude-flow-smoke-cleanup";
    await closeSession(summary.session.id, clientId);
  }
}

async function allowPermissions(sessionId: string, requestIds: string[]) {
  for (const requestId of requestIds) {
    await requestJson(
      `/api/sessions/${sessionId}/permissions/${encodeURIComponent(requestId)}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          behavior: "allow",
          selectedActionId: "allow_for_session",
          decision: "approved_for_session",
        }),
      },
    );
  }
}

async function readPermissionIds(sessionId: string): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace("http", "ws") + "/api/events?replayFromSeq=1");
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out reading permission ids for ${sessionId}.`));
    }, 5000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ sessionIds: [sessionId] }));
    };
    ws.onmessage = (event) => {
      try {
        const batch = JSON.parse(String(event.data)) as {
          events?: Array<{
            sessionId?: string;
            type?: string;
            payload?: { request?: { id?: string } };
          }>;
        };
        const ids = (batch.events ?? [])
          .filter(
            (item) =>
              item.sessionId === sessionId && item.type === "permission.requested",
          )
          .map((item) => item.payload?.request?.id)
          .filter((value): value is string => typeof value === "string");
        clearTimeout(timeout);
        ws.close();
        resolve(ids);
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`Failed to open permission replay socket for ${sessionId}.`));
    };
  });
}

async function waitForIdleWithAutoPermissions(
  sessionId: string,
  timeoutMs = 240_000,
) {
  const started = Date.now();
  let last: SessionSummary | null = null;
  const handled = new Set<string>();
  while (Date.now() - started < timeoutMs) {
    for (const requestId of await readPermissionIds(sessionId)) {
      if (handled.has(requestId)) {
        continue;
      }
      await allowPermissions(sessionId, [requestId]);
      handled.add(requestId);
    }
    last = (await requestJson(`/api/sessions/${sessionId}`)).session as SessionSummary;
    if (["idle", "failed", "stopped"].includes(last.session.runtimeState)) {
      return {
        summary: last,
        permissionIds: [...handled],
      };
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out waiting for ${sessionId}; last=${JSON.stringify(last)}`);
}

async function main() {
  await cleanupLiveClaudeSessions();

  const clientId = `claude-flow-smoke-${Date.now()}`;
  const cwd = await Bun.$`mktemp -d -t rah-claude-flow`.text();
  const workdir = cwd.trim();
  await Bun.write(`${workdir}/alpha.txt`, "ALPHA-CLAUDE\n");

  let liveSessionId: string | null = null;
  let replaySessionId: string | null = null;
  let resumedSessionId: string | null = null;

  try {
    const started = await requestJson("/api/sessions/start", {
      method: "POST",
      body: JSON.stringify({
        provider: "claude",
        cwd: workdir,
        approvalPolicy: "never",
        attach: {
          client: { id: clientId, kind: "web", connectionId: clientId },
          mode: "interactive",
          claimControl: true,
        },
      }),
    });
    liveSessionId = started.session.session.id;

    const firstPrompt =
      "Use only the Read and Write tools. Do not use Bash, Glob, Grep, or web tools. " +
      "Read alpha.txt. Then create beta.txt containing exactly BETA-CLAUDE on one line. " +
      "Finally answer with exactly DONE-1.";
    await requestJson(`/api/sessions/${liveSessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ clientId, text: firstPrompt }),
    });

    const firstDone = await waitForIdleWithAutoPermissions(liveSessionId);
    const firstPermissionIds = firstDone.permissionIds;
    const firstSummary = firstDone.summary;
    const providerSessionId = firstSummary.session.providerSessionId;
    if (!providerSessionId) {
      throw new Error("Claude live session never published a providerSessionId.");
    }

    const betaContent = await Bun.file(`${workdir}/beta.txt`).text();
    if (betaContent.trim() !== "BETA-CLAUDE") {
      throw new Error(`Unexpected beta.txt content: ${JSON.stringify(betaContent)}`);
    }

    await closeSession(liveSessionId, clientId);
    liveSessionId = null;

    const listed = await requestJson("/api/sessions") as {
      recentSessions: Array<Record<string, unknown>>;
      storedSessions: Array<Record<string, unknown>>;
    };
    const recent = listed.recentSessions.filter(
      (item) => item.provider === "claude" && item.providerSessionId === providerSessionId,
    );
    const stored = listed.storedSessions.filter(
      (item) => item.provider === "claude" && item.providerSessionId === providerSessionId,
    );
    if (recent.length === 0 || stored.length === 0) {
      throw new Error("Closed Claude session did not appear in recent/stored history.");
    }

    const replay = await requestJson("/api/sessions/resume", {
      method: "POST",
      body: JSON.stringify({
        provider: "claude",
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
      throw new Error("Claude replay session should be read-only.");
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
    const toolNames = history.events
      .filter((event) => event.type === "tool.call.completed")
      .map((event) => (event.payload.toolCall as { providerToolName?: string }).providerToolName)
      .filter((value): value is string => typeof value === "string");
    if (!assistantTexts.some((text) => text.includes("DONE-1"))) {
      throw new Error("Claude replay history did not include the final assistant answer.");
    }
    if (toolNames.length === 0) {
      throw new Error("Claude replay history did not include any tool calls.");
    }

    await closeSession(replaySessionId, clientId);
    replaySessionId = null;

    const resumed = await requestJson("/api/sessions/resume", {
      method: "POST",
      body: JSON.stringify({
        provider: "claude",
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
      throw new Error("Claude resumed live session should be interactive.");
    }

    const secondPrompt =
      "Use only the Read and Write tools. Do not use Bash, Glob, Grep, or web tools. " +
      "Read beta.txt. Then create gamma.txt containing exactly GAMMA-CLAUDE on one line. " +
      "Finally answer with exactly DONE-2.";
    await requestJson(`/api/sessions/${resumedSessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ clientId, text: secondPrompt }),
    });

    const secondDone = await waitForIdleWithAutoPermissions(resumedSessionId);
    const secondPermissionIds = secondDone.permissionIds;
    const secondSummary = secondDone.summary;
    if (secondSummary.session.providerSessionId !== providerSessionId) {
      throw new Error("Claude live resume changed providerSessionId unexpectedly.");
    }

    const gammaContent = await Bun.file(`${workdir}/gamma.txt`).text();
    if (gammaContent.trim() !== "GAMMA-CLAUDE") {
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
          firstPermissionCount: firstPermissionIds.length,
          secondPermissionCount: secondPermissionIds.length,
          historyAssistantTexts: assistantTexts.slice(0, 5),
          historyToolNames: toolNames,
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
    await Bun.$`rm -rf ${workdir}`;
  }
}

await main();
