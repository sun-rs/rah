import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Provider = "codex" | "opencode";

type JsonRecord = Record<string, unknown>;

type SessionSummary = {
  id: string;
  provider: Provider;
  providerSessionId?: string;
  runtimeState?: string;
  activeTurnId?: string | null;
  cwd?: string;
  title?: string;
  liveBackend?: string;
  runtimeDiagnostics?: {
    serverEndpoint?: string;
  };
  model?: {
    currentModelId?: string | null;
    currentReasoningId?: string | null;
  };
  mode?: {
    currentModeId?: string | null;
    availableModes?: Array<{ id: string; role?: string }>;
  };
  config?: {
    values?: Record<string, unknown>;
  };
};

type ProbeResult = {
  provider: Provider;
  check: string;
  ok: boolean;
  evidence: JsonRecord;
};

type ProbeSession = SessionSummary & {
  probeClientId: string;
};

type TokenSample = {
  reasoningTokens: number;
  marker: string;
  trial: number;
};

const args = new Set(process.argv.slice(2));
const providerArg = valueAfter("--provider");
const baseUrl = process.env.RAH_BASE_URL ?? "http://127.0.0.1:43111";
const workspace = process.env.RAH_PROBE_WORKSPACE ?? process.cwd();
const clientPrefix = `web-session-control-probe-${Date.now()}`;
const sharedWebClientId = "web-user";
const keepSessions = args.has("--keep-sessions");
const skipTokenOrder = process.env.RAH_SESSION_CONTROL_SKIP_TOKEN_ORDER === "1";
const requireTokenOrder =
  process.env.RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER === "1" && !skipTokenOrder;
const tokenTrials = parsePositiveInteger(
  process.env.RAH_SESSION_CONTROL_TOKEN_TRIALS,
  1,
);
const tokenMinRatio = parsePositiveNumber(
  process.env.RAH_SESSION_CONTROL_TOKEN_MIN_RATIO,
  1,
);

const codexModel = process.env.RAH_CODEX_PROBE_MODEL ?? "gpt-5.5";
const codexLowEffort = process.env.RAH_CODEX_PROBE_LOW_EFFORT ?? "low";
const codexHighEffort = process.env.RAH_CODEX_PROBE_HIGH_EFFORT ?? "xhigh";
const opencodeGrokModel = process.env.RAH_OPENCODE_PROBE_GROK_MODEL ?? "aihubmix/grok-4.3";
const includeOpenCodeDeepSeek = process.env.RAH_OPENCODE_PROBE_DEEPSEEK === "1";
const opencodeDeepseekModel =
  process.env.RAH_OPENCODE_PROBE_DEEPSEEK_MODEL ?? "deepseek/deepseek-v4-pro";

const mathPrompts = [
  "Solve this nontrivial math classification problem rigorously. Include the marker and exact model id in the final answer. " +
    "Problem A: Find all quadruples of positive integers (a,b,c,d) with a <= b <= c <= d and " +
    "1/a + 1/b + 1/c + 1/d = 1. Give a concise but complete proof by cases, including the bounds used in each case.",
  "Solve this nontrivial math classification problem rigorously. Include the marker and exact model id in the final answer. " +
    "Problem B: Find all triples of positive integers (a,b,c) with a <= b <= c and " +
    "1/a + 1/b + 1/c = 1/2. Give a concise but complete proof by cases, including the bounds used in each case.",
  "Solve this nontrivial math classification problem rigorously. Include the marker and exact model id in the final answer. " +
    "Problem C: Find all quadruples of positive integers (a,b,c,d) with a <= b <= c <= d and " +
    "1/a + 1/b + 1/c + 1/d = 1/2. Give a concise but complete proof by cases, including the bounds used in each case.",
];

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  if (args.has("--help")) {
    printHelp();
    return;
  }

  const providers = resolveProviders(providerArg);
  const results: ProbeResult[] = [];

  await requireDaemon();

  if (providers.includes("codex")) {
    results.push(...(await runCodexProbe()));
  }
  if (providers.includes("opencode")) {
    results.push(...(await runOpenCodeProbe()));
  }

  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, baseUrl, workspace, results }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function valueAfter(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printHelp() {
  console.log(`Usage: npm run test:smoke:session-control-capabilities -- [--provider codex|opencode|all] [--keep-sessions]

Runs real provider E2E probes against a running RAH daemon.

Environment:
  RAH_BASE_URL                         Default: http://127.0.0.1:43111
  RAH_PROBE_WORKSPACE                  Default: current working directory
  RAH_CODEX_PROBE_MODEL                Default: gpt-5.5
  RAH_CODEX_PROBE_LOW_EFFORT           Default: low
  RAH_CODEX_PROBE_HIGH_EFFORT          Default: xhigh
  RAH_OPENCODE_PROBE_GROK_MODEL        Default: aihubmix/grok-4.3
  RAH_OPENCODE_PROBE_DEEPSEEK          Set to 1 to also probe DeepSeek.
  RAH_OPENCODE_PROBE_DEEPSEEK_MODEL    Default: deepseek/deepseek-v4-pro when DeepSeek probing is enabled.
  RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER
                                      Set to 1 to require aggregate high>low token assertions.
  RAH_SESSION_CONTROL_TOKEN_TRIALS     Number of paired hard math prompts. Default: ${tokenTrials} in this run.
  RAH_SESSION_CONTROL_TOKEN_MIN_RATIO  Required high/low aggregate token ratio. Default: ${tokenMinRatio}.
  RAH_SESSION_CONTROL_SKIP_TOKEN_ORDER Legacy alias that always skips token differential assertions.

This test consumes real provider quota. It is intentionally not part of test:runtime.`);
}

function resolveProviders(value: string | undefined): Provider[] {
  if (!value || value === "all") {
    return ["codex", "opencode"];
  }
  if (value === "codex" || value === "opencode") {
    return [value];
  }
  throw new Error(`Unsupported --provider '${value}'. Use codex, opencode, or all.`);
}

async function requireDaemon() {
  await requestJson(`${baseUrl}/api/sessions`);
}

async function runCodexProbe(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const lowSamples = [];
  const highSamples = [];
  for (let trial = 0; trial < tokenTrials; trial += 1) {
    const low = await runCodexEffortCase(codexLowEffort, "LOW", trial);
    const high = await runCodexEffortCase(codexHighEffort, "XHIGH", trial);
    lowSamples.push(low);
    highSamples.push(high);
    results.push(low.result, high.result);
  }
  results.push(
    compareReasoningTokenSamples("codex", "effort-token-differential", lowSamples, highSamples),
  );

  const plan = await runCodexPlanProbe();
  results.push(...plan);
  return results;
}

async function runCodexEffortCase(effort: string, label: string, trial: number) {
  const marker = `RAH_CODEX_SESSION_CONTROL_${label}_T${trial + 1}_${Date.now()}`;
  const session = await startSession({
    provider: "codex",
    title: `RAH Codex session control ${label}`,
    clientSlug: `codex-${label}`,
  });
  try {
    const configured = await setSessionModel(session.id, {
      model: codexModel,
      optionKey: "model_reasoning_effort",
      reasoning: effort,
    });
    await sendInput(session.id, `${marker}\n${mathPromptForTrial(trial)}`, session.probeClientId);
    await waitSessionAfterInput(session.id);
    const evidence = await readCodexEvidence(session.providerSessionId, marker);
    const ok =
      evidence.turnContext.model === codexModel &&
      evidence.turnContext.effort === effort &&
      evidence.turnContext.collaborationMode === "default" &&
      typeof evidence.lastTokenUsage.reasoning_output_tokens === "number";
    return {
      reasoningTokens: Number(evidence.lastTokenUsage.reasoning_output_tokens ?? 0),
      marker,
      trial: trial + 1,
      result: result("codex", `model-effort-${effort}`, ok, {
        sessionId: session.id,
        providerSessionId: session.providerSessionId,
        trial: trial + 1,
        expected: { model: codexModel, effort },
        configured: summarizeConfiguredSession(configured),
        ...evidence,
      }),
    };
  } finally {
    await maybeCloseSession(session);
  }
}

async function runCodexPlanProbe(): Promise<ProbeResult[]> {
  const session = await startSession({
    provider: "codex",
    title: "RAH Codex plan probe",
    clientSlug: "codex-plan",
  });
  try {
    await setSessionModel(session.id, {
      model: codexModel,
      optionKey: "model_reasoning_effort",
      reasoning: "low",
    });
    const before = await getSession(session.id);
    const nonPlanMode = pickNonPlanMode(before, "never/danger-full-access");
    const planMarker = `RAH_CODEX_SESSION_CONTROL_PLAN_ON_${Date.now()}`;
    await setMode(session.id, "plan");
    await sendInput(
      session.id,
      `${planMarker}\nAre you currently in plan mode? Reply with one short sentence and include the marker.`,
      session.probeClientId,
    );
    await waitSessionAfterInput(session.id);
    const planEvidence = await readCodexEvidence(session.providerSessionId, planMarker);

    const offMarker = `RAH_CODEX_SESSION_CONTROL_PLAN_OFF_${Date.now()}`;
    await setMode(session.id, nonPlanMode);
    await sendInput(
      session.id,
      `${offMarker}\nAre you currently in plan mode? Reply with one short sentence and include the marker.`,
      session.probeClientId,
    );
    await waitSessionAfterInput(session.id);
    const offEvidence = await readCodexEvidence(session.providerSessionId, offMarker);

    return [
      result("codex", "plan-mode-on", planEvidence.turnContext.collaborationMode === "plan", {
        sessionId: session.id,
        providerSessionId: session.providerSessionId,
        marker: planMarker,
        ...planEvidence,
      }),
      result("codex", "plan-mode-off", offEvidence.turnContext.collaborationMode !== "plan", {
        sessionId: session.id,
        providerSessionId: session.providerSessionId,
        marker: offMarker,
        restoredMode: nonPlanMode,
        ...offEvidence,
      }),
    ];
  } finally {
    await maybeCloseSession(session);
  }
}

async function runOpenCodeProbe(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const models = [
    opencodeGrokModel,
    ...(includeOpenCodeDeepSeek ? [opencodeDeepseekModel] : []),
  ];
  for (const model of models) {
    const lowSamples = [];
    const highSamples = [];
    for (let trial = 0; trial < tokenTrials; trial += 1) {
      const low = await runOpenCodeEffortCase(model, "low", trial);
      const high = await runOpenCodeEffortCase(model, "high", trial);
      lowSamples.push(low);
      highSamples.push(high);
      results.push(low.result, high.result);
    }
    results.push(
      compareReasoningTokenSamples(
        "opencode",
        `${model}-token-differential`,
        lowSamples,
        highSamples,
      ),
    );
  }
  results.push(...(await runOpenCodePlanProbe()));
  return results;
}

async function runOpenCodeEffortCase(model: string, effort: string, trial: number) {
  const marker = `RAH_OPENCODE_SESSION_CONTROL_${model.replace(/[^a-z0-9]+/gi, "_")}_${effort}_T${trial + 1}_${Date.now()}`;
  const session = await startSession({
    provider: "opencode",
    title: `RAH OpenCode session control ${model} ${effort}`,
    clientSlug: `opencode-${model.replace(/[^a-z0-9]+/gi, "-")}-${effort}`,
  });
  try {
    const configured = await setSessionModel(session.id, {
      model,
      optionKey: "model_reasoning_variant",
      reasoning: effort,
    });
    await sendInput(session.id, `${marker}\n${mathPromptForTrial(trial)}`, session.probeClientId);
    const evidence = await readOpenCodeEvidence(await getSession(session.id), marker);
    const expected = splitProviderModel(model);
    const ok =
      evidence.assistant.providerID === expected.providerID &&
      evidence.assistant.modelID === expected.modelID &&
      evidence.assistant.variant === effort &&
      typeof evidence.assistant.tokens?.reasoning === "number";
    return {
      reasoningTokens: Number(evidence.assistant.tokens?.reasoning ?? 0),
      marker,
      trial: trial + 1,
      result: result("opencode", `${model}-effort-${effort}`, ok, {
        sessionId: session.id,
        providerSessionId: session.providerSessionId,
        trial: trial + 1,
        expected: { ...expected, variant: effort },
        configured: summarizeConfiguredSession(configured),
        ...evidence,
      }),
    };
  } finally {
    await maybeCloseSession(session);
  }
}

async function runOpenCodePlanProbe(): Promise<ProbeResult[]> {
  const session = await startSession({
    provider: "opencode",
    title: "RAH OpenCode plan probe",
    clientSlug: "opencode-plan",
  });
  try {
    await setSessionModel(session.id, {
      model: opencodeGrokModel,
      optionKey: "model_reasoning_variant",
      reasoning: "low",
    });
    const planMarker = `RAH_OPENCODE_SESSION_CONTROL_PLAN_ON_${Date.now()}`;
    await setMode(session.id, "plan");
    await sendInput(
      session.id,
      `${planMarker}\nAre you currently in plan mode? Reply with one short sentence and include the marker.`,
      session.probeClientId,
    );
    const planEvidence = await readOpenCodeEvidence(await getSession(session.id), planMarker);

    const offMarker = `RAH_OPENCODE_SESSION_CONTROL_PLAN_OFF_${Date.now()}`;
    await setMode(session.id, "build");
    await sendInput(
      session.id,
      `${offMarker}\nAre you currently in plan mode? Reply with one short sentence and include the marker.`,
      session.probeClientId,
    );
    const offEvidence = await readOpenCodeEvidence(await getSession(session.id), offMarker);

    return [
      result(
        "opencode",
        "plan-mode-on",
        planEvidence.assistant.mode === "plan" && planEvidence.assistant.agent === "plan",
        {
          sessionId: session.id,
          providerSessionId: session.providerSessionId,
          marker: planMarker,
          ...planEvidence,
        },
      ),
      result(
        "opencode",
        "plan-mode-off",
        planEvidence.assistant.mode === "plan" &&
          offEvidence.assistant.mode !== "plan" &&
          offEvidence.assistant.agent !== "plan",
        {
          sessionId: session.id,
          providerSessionId: session.providerSessionId,
          marker: offMarker,
          ...offEvidence,
        },
      ),
    ];
  } finally {
    await maybeCloseSession(session);
  }
}

function compareReasoningTokenSamples(
  provider: Provider,
  check: string,
  lowSamples: TokenSample[],
  highSamples: TokenSample[],
): ProbeResult {
  const lowTotal = sumReasoningTokens(lowSamples);
  const highTotal = sumReasoningTokens(highSamples);
  const highLowRatio = lowTotal > 0 ? highTotal / lowTotal : null;
  const passedTokenOrder = lowTotal > 0 && highTotal > lowTotal * tokenMinRatio;
  const ok = !requireTokenOrder || passedTokenOrder;
  return result(provider, check, ok, {
    required: requireTokenOrder,
    skipped: skipTokenOrder,
    tokenTrials,
    tokenMinRatio,
    passedTokenOrder,
    lowReasoningTokens: lowTotal,
    highReasoningTokens: highTotal,
    highLowRatio,
    lowSamples,
    highSamples,
  });
}

async function startSession(args: {
  provider: Provider;
  title: string;
  clientSlug: string;
}): Promise<ProbeSession> {
  const clientId = `${clientPrefix}-${args.clientSlug}`;
  const response = await requestJson<{ session: { session?: SessionSummary } | SessionSummary }>(
    `${baseUrl}/api/sessions/start`,
    {
      method: "POST",
      body: {
        provider: args.provider,
        cwd: workspace,
        liveBackend: "native_local_server",
        title: args.title,
        attach: {
          client: {
            id: clientId,
            kind: "web",
            connectionId: clientId,
          },
          mode: "interactive",
          claimControl: true,
        },
      },
    },
  );
  const session = unwrapSession(response.session);
  assertNonEmpty(session.id, "started session id");
  assertNonEmpty(session.providerSessionId, "started provider session id");
  await waitSessionIdle(session.id);
  await attachSession(session.id, clientId);
  return { ...(await getSession(session.id)), probeClientId: clientId };
}

async function getSession(sessionId: string): Promise<SessionSummary> {
  const response = await requestJson<{ session: { session?: SessionSummary } | SessionSummary }>(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
  );
  return unwrapSession(response.session);
}

async function setMode(sessionId: string, modeId: string): Promise<SessionSummary> {
  const response = await requestJson<{ session: { session?: SessionSummary } | SessionSummary }>(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/mode`,
    {
      method: "POST",
      body: { modeId },
    },
  );
  return unwrapSession(response.session);
}

async function attachSession(sessionId: string, clientId: string): Promise<void> {
  await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/attach`, {
    method: "POST",
    body: {
      client: {
        id: clientId,
        kind: "web",
        connectionId: clientId,
      },
      mode: "interactive",
      claimControl: true,
    },
  });
}

async function setSessionModel(
  sessionId: string,
  args: {
    model: string;
    optionKey: string;
    reasoning: string;
  },
): Promise<SessionSummary> {
  const response = await requestJson<{ session: { session?: SessionSummary } | SessionSummary }>(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/model`,
    {
      method: "POST",
      body: {
        modelId: args.model,
        reasoningId: args.reasoning,
        optionValues: { [args.optionKey]: args.reasoning },
      },
    },
  );
  const session = unwrapSession(response.session);
  await waitSessionIdle(sessionId);
  return session;
}

async function sendInput(sessionId: string, text: string, clientId: string): Promise<void> {
  await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    body: {
      clientId,
      text,
      clientMessageId: `${clientId}-message-${Date.now()}`,
      clientTurnId: `${clientId}-turn-${Date.now()}`,
    },
  });
}

async function waitSessionIdle(sessionId: string, timeoutMs = 300_000): Promise<SessionSummary> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = await getSession(sessionId);
    if (session.runtimeState === "idle" && !session.activeTurnId) {
      return session;
    }
    await delay(1_500);
  }
  throw new Error(`Timed out waiting for session ${sessionId} to become idle.`);
}

async function waitSessionAfterInput(
  sessionId: string,
  timeoutMs = 300_000,
): Promise<SessionSummary> {
  const start = Date.now();
  let observedBusy = false;
  while (Date.now() - start < timeoutMs) {
    const session = await getSession(sessionId);
    const idle = session.runtimeState === "idle" && !session.activeTurnId;
    if (!idle) {
      observedBusy = true;
    }
    if (observedBusy && idle) {
      return session;
    }
    // Some provider turns can complete before the next poll. Avoid returning
    // immediately after send, but do not block forever waiting for a busy edge.
    if (!observedBusy && idle && Date.now() - start > 5_000) {
      return session;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for session ${sessionId} input turn to finish.`);
}

async function maybeCloseSession(session: ProbeSession): Promise<void> {
  if (keepSessions) {
    return;
  }
  try {
    await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/close`, {
      method: "POST",
      body: { clientId: sharedWebClientId },
    });
  } catch (error) {
    console.warn(`Failed to close probe session ${session.id}: ${readError(error)}`);
  }
}

async function readCodexEvidence(providerSessionId: string | undefined, marker: string) {
  assertNonEmpty(providerSessionId, "Codex provider session id");
  const file = await waitForCodexRollout(providerSessionId);
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const evidence = await parseCodexRollout(file, marker);
    if (evidence) {
      return { file, ...evidence };
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for Codex marker ${marker} in ${file}.`);
}

async function waitForCodexRollout(providerSessionId: string): Promise<string> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const found = await findFile(root, (file) => file.endsWith(`${providerSessionId}.jsonl`));
    if (found) {
      return found;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Codex rollout for ${providerSessionId}.`);
}

async function parseCodexRollout(file: string, marker: string) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  let latestTurnContext: JsonRecord | null = null;
  let selectedTurnContext: JsonRecord | null = null;
  let lastTokenUsage: JsonRecord | null = null;
  let taskComplete: JsonRecord | null = null;
  let agentMessage = "";
  let markerSeen = false;

  for (const line of lines) {
    const event = parseJson(line);
    if (!event) {
      continue;
    }
    if (event.type === "turn_context" && isRecord(event.payload)) {
      latestTurnContext = event.payload;
    }
    if (JSON.stringify(event).includes(marker) && !markerSeen) {
      markerSeen = true;
      selectedTurnContext = latestTurnContext;
    }
    if (!markerSeen) {
      continue;
    }
    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.type === "event_msg" && payload.type === "agent_message") {
      agentMessage = String(payload.message ?? "");
    }
    if (event.type === "event_msg" && payload.type === "token_count" && isRecord(payload.info)) {
      const info = payload.info;
      if (isRecord(info.last_token_usage)) {
        lastTokenUsage = info.last_token_usage;
      }
    }
    if (event.type === "event_msg" && payload.type === "task_complete") {
      taskComplete = payload;
      break;
    }
  }

  if (!markerSeen || !selectedTurnContext || !lastTokenUsage) {
    return null;
  }

  const collaborationMode = isRecord(selectedTurnContext.collaboration_mode)
    ? String(selectedTurnContext.collaboration_mode.mode ?? "")
    : "";
  const collaborationSettings = isRecord(selectedTurnContext.collaboration_mode)
    ? selectedTurnContext.collaboration_mode.settings
    : undefined;
  return {
    marker,
    turnContext: {
      turnId: selectedTurnContext.turn_id,
      model: selectedTurnContext.model,
      effort: selectedTurnContext.effort,
      collaborationMode,
      collaborationReasoning: isRecord(collaborationSettings)
        ? collaborationSettings.reasoning_effort
        : undefined,
    },
    lastTokenUsage,
    taskComplete,
    agentMessagePreview: agentMessage.slice(0, 500),
  };
}

async function readOpenCodeEvidence(session: SessionSummary, marker: string) {
  const endpoint = session.runtimeDiagnostics?.serverEndpoint;
  assertNonEmpty(endpoint, "OpenCode server endpoint");
  assertNonEmpty(session.providerSessionId, "OpenCode provider session id");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const messages = await requestJson<JsonRecord[]>(
      `${endpoint}/session/${encodeURIComponent(session.providerSessionId)}/message`,
    );
    const user = [...messages].reverse().find((message) => {
      return messageRole(message) === "user" && messageText(message).includes(marker);
    });
    if (user) {
      const userInfo = recordField(user, "info");
      const userId = String(userInfo.id ?? "");
      const assistant = messages.find((message) => {
        const info = recordField(message, "info");
        return (
          info.role === "assistant" &&
          info.parentID === userId &&
          isRecord(info.time) &&
          info.time.completed !== undefined
        );
      });
      if (assistant) {
        const assistantInfo = recordField(assistant, "info");
        const tokens = recordField(assistantInfo, "tokens");
        return {
          marker,
          user: {
            id: userId,
            agent: userInfo.agent,
            text: messageText(user).slice(0, 500),
          },
          assistant: {
            id: assistantInfo.id,
            parentID: assistantInfo.parentID,
            providerID: assistantInfo.providerID,
            modelID: assistantInfo.modelID,
            variant: assistantInfo.variant,
            mode: assistantInfo.mode,
            agent: assistantInfo.agent,
            finish: assistantInfo.finish,
            tokens,
            text: messageText(assistant).slice(0, 500),
          },
        };
      }
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for OpenCode marker ${marker}.`);
}

function unwrapSession(value: { session?: SessionSummary } | SessionSummary): SessionSummary {
  if ("session" in value && value.session) {
    return value.session;
  }
  return value as SessionSummary;
}

function pickNonPlanMode(session: SessionSummary, fallback: string): string {
  if (session.mode?.currentModeId && session.mode.currentModeId !== "plan") {
    return session.mode.currentModeId;
  }
  return session.mode?.availableModes?.find((mode) => mode.id !== "plan")?.id ?? fallback;
}

function splitProviderModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`Expected provider/model id, got '${model}'.`);
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

function result(provider: Provider, check: string, ok: boolean, evidence: JsonRecord): ProbeResult {
  return { provider, check, ok, evidence };
}

function mathPromptForTrial(trial: number): string {
  return mathPrompts[trial % mathPrompts.length]!;
}

function sumReasoningTokens(samples: TokenSample[]): number {
  return samples.reduce((sum, sample) => sum + sample.reasoningTokens, 0);
}

function summarizeConfiguredSession(session: SessionSummary): JsonRecord {
  return {
    currentModelId: session.model?.currentModelId,
    currentReasoningId: session.model?.currentReasoningId,
    modelMutable: session.model?.mutable,
    modelSource: session.model?.source,
    configValues: session.config?.values,
    configSource: session.config?.source,
  };
}

function messageRole(message: JsonRecord): string {
  return String(recordField(message, "info").role ?? "");
}

function messageText(message: JsonRecord): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((part): part is JsonRecord => isRecord(part))
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

async function requestJson<T = unknown>(
  url: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(url, {
    method: options?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-rah-client": "session-control-capability-probe",
    },
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);
  if (!response.ok) {
    throw new Error(`${options?.method ?? "GET"} ${url} -> ${response.status}: ${text}`);
  }
  return body;
}

async function findFile(
  dir: string,
  predicate: (file: string) => boolean,
): Promise<string | null> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && predicate(full)) {
      return full;
    }
    if (entry.isDirectory()) {
      const found = await findFile(full, predicate);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function parseJson(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordField(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${label}.`);
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got '${value}'.`);
  }
  return parsed;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, got '${value}'.`);
  }
  return parsed;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
