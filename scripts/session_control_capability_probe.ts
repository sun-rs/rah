import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { movePathToTrashIfExists } from "./safe-trash";

type Provider = "codex" | "claude" | "opencode";

type JsonRecord = Record<string, unknown>;

type SessionModeDescriptor = {
  id: string;
  role?: string;
  label?: string;
  description?: string;
};

type SessionSummary = {
  id: string;
  provider: Provider;
  providerSessionId?: string;
  runtimeState?: string;
  activeTurnId?: string | null;
  cwd?: string;
  rootDir?: string;
  title?: string;
  liveBackend?: string;
  runtimeDiagnostics?: {
    serverEndpoint?: string;
  };
  model?: {
    currentModelId?: string | null;
    currentReasoningId?: string | null;
    mutable?: boolean;
    source?: string;
  };
  mode?: {
    currentModeId?: string | null;
    availableModes?: SessionModeDescriptor[];
    mutable?: boolean;
    source?: string;
  };
  config?: {
    values?: Record<string, unknown>;
    source?: string;
  };
};

type ProviderModelCatalog = {
  provider: Provider;
  defaultModeId?: string;
  modes?: SessionModeDescriptor[];
  source?: string;
  sourceDetail?: string;
  freshness?: string;
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
const workspaceOverride = process.env.RAH_PROBE_WORKSPACE?.trim() || null;
let workspace = workspaceOverride ?? "";
let autoWorkspaceRoot: string | null = null;
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
const skipModelEffortProbes =
  process.env.RAH_SESSION_CONTROL_SKIP_MODEL_EFFORT_PROBES === "1";
const skipPermissionProbes =
  process.env.RAH_SESSION_CONTROL_SKIP_PERMISSION_PROBES === "1";
const permissionProbeTimeoutMs = parsePositiveInteger(
  process.env.RAH_SESSION_CONTROL_PERMISSION_TIMEOUT_MS,
  180_000,
);

const codexModel = process.env.RAH_CODEX_PROBE_MODEL ?? "gpt-5.5";
const codexLowEffort = process.env.RAH_CODEX_PROBE_LOW_EFFORT ?? "low";
const codexHighEffort = process.env.RAH_CODEX_PROBE_HIGH_EFFORT ?? "xhigh";
const claudeProbeModel = process.env.RAH_CLAUDE_PROBE_MODEL;
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
  if (!workspaceOverride) {
    autoWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "rah-session-control-workspace-"));
    workspace = path.join(autoWorkspaceRoot, "workspace");
    await mkdir(workspace, { recursive: true });
  } else {
    workspace = workspaceOverride;
  }

  try {
    if (providers.includes("codex")) {
      results.push(...(await runCodexProbe()));
    }
    if (providers.includes("claude")) {
      results.push(...(await runClaudeProbe()));
    }
    if (providers.includes("opencode")) {
      results.push(...(await runOpenCodeProbe()));
    }

    const failed = results.filter((result) => !result.ok);
    console.log(JSON.stringify({ ok: failed.length === 0, baseUrl, workspace, results }, null, 2));
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (!keepSessions && workspace && !workspaceOverride) {
      await cleanupProbeWorkspace(workspace, autoWorkspaceRoot ?? undefined);
    }
  }
}

function valueAfter(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printHelp() {
  console.log(`Usage:
  npm run test:smoke:session-control-capabilities -- [--provider codex|claude|opencode|all] [--keep-sessions]
  npm run test:smoke:session-control-token-order -- [--provider codex|opencode|all] [--keep-sessions]

Runs real provider E2E probes against a running RAH daemon.

Environment:
  RAH_BASE_URL                         Default: http://127.0.0.1:43111
  RAH_PROBE_WORKSPACE                  Optional. Default: isolated temp workspace, removed after the probe.
  RAH_CODEX_PROBE_MODEL                Default: gpt-5.5
  RAH_CODEX_PROBE_LOW_EFFORT           Default: low
  RAH_CODEX_PROBE_HIGH_EFFORT          Default: xhigh
  RAH_CLAUDE_PROBE_MODEL               Optional Claude model for permission-mode probes.
  RAH_OPENCODE_PROBE_GROK_MODEL        Default: aihubmix/grok-4.3
  RAH_OPENCODE_PROBE_DEEPSEEK          Set to 1 to also probe DeepSeek.
  RAH_OPENCODE_PROBE_DEEPSEEK_MODEL    Default: deepseek/deepseek-v4-pro when DeepSeek probing is enabled.
  RAH_SESSION_CONTROL_SKIP_MODEL_EFFORT_PROBES
                                      Set to 1 to only run mode/permission/agent probes.
  RAH_SESSION_CONTROL_SKIP_PERMISSION_PROBES
                                      Set to 1 to skip real permission/agent behavior probes.
  RAH_SESSION_CONTROL_PERMISSION_TIMEOUT_MS
                                      Timeout for each file/permission behavior probe. Default: ${permissionProbeTimeoutMs}.
  RAH_SESSION_CONTROL_REQUIRE_TOKEN_ORDER
                                      Set to 1 to require aggregate high>low token assertions.
  RAH_SESSION_CONTROL_TOKEN_TRIALS     Number of paired hard math prompts. Default: ${tokenTrials} in this run.
  RAH_SESSION_CONTROL_TOKEN_MIN_RATIO  Required high/low aggregate token ratio. Default: ${tokenMinRatio}.
  RAH_SESSION_CONTROL_SKIP_TOKEN_ORDER Legacy alias that always skips token differential assertions.

This test consumes real provider quota. It is intentionally not part of test:runtime.`);
}

function resolveProviders(value: string | undefined): Provider[] {
  if (!value || value === "all") {
    if (requireTokenOrder) {
      return ["codex", "opencode"];
    }
    return ["codex", "claude", "opencode"];
  }
  if (value === "codex" || value === "claude" || value === "opencode") {
    return [value];
  }
  throw new Error(`Unsupported --provider '${value}'. Use codex, claude, opencode, or all.`);
}

async function requireDaemon() {
  await requestJson(`${baseUrl}/api/sessions`);
}

async function listProviderModelCatalog(provider: Provider): Promise<ProviderModelCatalog> {
  const query = new URLSearchParams();
  if (workspace) {
    query.set("cwd", workspace);
  }
  query.set("refresh", "1");
  const response = await requestJson<{ catalog: ProviderModelCatalog }>(
    `${baseUrl}/api/providers/${provider}/models?${query.toString()}`,
  );
  return response.catalog;
}

function normalizeModes(modes: readonly SessionModeDescriptor[] | undefined): SessionModeDescriptor[] {
  const seen = new Set<string>();
  const normalized: SessionModeDescriptor[] = [];
  for (const mode of modes ?? []) {
    const id = mode.id?.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({
      id,
      ...(mode.role ? { role: mode.role } : {}),
      ...(mode.label ? { label: mode.label } : {}),
      ...(mode.description ? { description: mode.description } : {}),
    });
  }
  return normalized;
}

function mergeModes(
  first: readonly SessionModeDescriptor[] | undefined,
  second: readonly SessionModeDescriptor[] | undefined,
): SessionModeDescriptor[] {
  return normalizeModes([...(first ?? []), ...(second ?? [])]);
}

function selectModeByRole(
  modes: readonly SessionModeDescriptor[] | undefined,
  role: string,
): SessionModeDescriptor | null {
  return normalizeModes(modes).find((mode) => mode.role === role) ?? null;
}

function selectOpenCodeAgentProbeModes(
  modes: readonly SessionModeDescriptor[] | undefined,
): SessionModeDescriptor[] {
  const candidates = normalizeModes(modes).filter((mode) => {
    return mode.role === undefined || mode.role === "custom" || mode.role === "agent";
  });
  const planLike = candidates.find((mode) => {
    const text = `${mode.id} ${mode.label ?? ""} ${mode.description ?? ""}`.toLowerCase();
    return /\b(plan|planner|planning)\b/.test(text);
  });
  const nonPlanLike = candidates.find((mode) => mode.id !== planLike?.id);
  const selected = [planLike, nonPlanLike, candidates[0], candidates[1]].filter(
    (mode): mode is SessionModeDescriptor => Boolean(mode),
  );
  return normalizeModes(selected).slice(0, 2);
}

async function runCodexProbe(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const lowSamples = [];
  const highSamples = [];
  if (!skipModelEffortProbes) {
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
  } else {
    results.push(
      result("codex", "model-effort-probes-skipped", true, {
        skipped: true,
        reason: "RAH_SESSION_CONTROL_SKIP_MODEL_EFFORT_PROBES=1",
      }),
    );
  }

  const plan = await runCodexPlanProbe();
  results.push(...plan);
  if (!skipPermissionProbes) {
    results.push(...(await runCodexPermissionProbe()));
  }
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
  const catalog = await listProviderModelCatalog("codex");
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
    const nonPlanMode = selectModeByRole(mergeModes(catalog.modes, before.mode?.availableModes), "ask");
    if (!nonPlanMode) {
      return [
        missingModeResult("codex", "plan-mode-on", "ask", {
          catalog,
          sessionMode: summarizeMode(before),
        }),
        missingModeResult("codex", "plan-mode-off", "ask", {
          catalog,
          sessionMode: summarizeMode(before),
        }),
      ];
    }
    const planMarker = `RAH_CODEX_SESSION_CONTROL_PLAN_ON_${Date.now()}`;
    await setMode(session.id, `plan:${nonPlanMode.id}`);
    await sendInput(
      session.id,
      `${planMarker}\nAre you currently in plan mode? Reply with one short sentence and include the marker.`,
      session.probeClientId,
    );
    await waitSessionAfterInput(session.id);
    const planEvidence = await readCodexEvidence(session.providerSessionId, planMarker);

    const offMarker = `RAH_CODEX_SESSION_CONTROL_PLAN_OFF_${Date.now()}`;
    await setMode(session.id, nonPlanMode.id);
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
        selectedAccessMode: nonPlanMode,
        ...planEvidence,
      }),
      result("codex", "plan-mode-off", offEvidence.turnContext.collaborationMode !== "plan", {
        sessionId: session.id,
        providerSessionId: session.providerSessionId,
        marker: offMarker,
        restoredMode: nonPlanMode.id,
        ...offEvidence,
      }),
    ];
  } finally {
    await maybeCloseSession(session);
  }
}

async function runCodexPermissionProbe(): Promise<ProbeResult[]> {
  const catalog = await listProviderModelCatalog("codex");
  const modes = normalizeModes(catalog.modes);
  const autoReviewMode = selectModeByRole(modes, "auto_edit");
  const defaultMode = selectModeByRole(modes, "ask");
  const fullAccessMode = selectModeByRole(modes, "full_auto");
  const results: ProbeResult[] = [];
  if (autoReviewMode) {
    results.push(
      await runCodexPermissionMetadataCase({
        mode: autoReviewMode,
        check: "permission-auto-review-metadata",
        expected: {
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          approvalsReviewer: "auto_review",
        },
      }),
    );
  } else {
    results.push(missingModeResult("codex", "permission-auto-review-metadata", "auto_edit", { catalog }));
  }
  if (defaultMode) {
    results.push(
      await runCodexOutsideWriteCase({
        mode: defaultMode,
        check: "permission-default-outside-write-requires-approval",
        expected: "approval_required",
      }),
    );
  } else {
    results.push(missingModeResult("codex", "permission-default-outside-write-requires-approval", "ask", { catalog }));
  }
  if (fullAccessMode) {
    results.push(
      await runCodexOutsideWriteCase({
        mode: fullAccessMode,
        check: "permission-full-access-outside-write-succeeds",
        expected: "file_created",
      }),
    );
  } else {
    results.push(missingModeResult("codex", "permission-full-access-outside-write-succeeds", "full_auto", { catalog }));
  }
  return results;
}

async function runCodexPermissionMetadataCase(args: {
  mode: SessionModeDescriptor;
  check: string;
  expected: {
    approvalPolicy: string;
    sandboxMode: string;
    approvalsReviewer?: string;
  };
}): Promise<ProbeResult> {
  const marker = `RAH_CODEX_PERMISSION_METADATA_${Date.now()}`;
  const session = await startSession({
    provider: "codex",
    title: `RAH Codex ${args.check}`,
    clientSlug: `codex-${args.check}`,
  });
  try {
    await setSessionModel(session.id, {
      model: codexModel,
      optionKey: "model_reasoning_effort",
      reasoning: "low",
    });
    const configured = await setMode(session.id, args.mode.id);
    await sendInput(
      session.id,
      `${marker}\nReply with the marker only. Do not run tools.`,
      session.probeClientId,
    );
    await waitSessionAfterInput(session.id);
    const evidence = await readCodexEvidence(session.providerSessionId, marker);
    const ok =
      evidence.turnContext.approvalPolicy === args.expected.approvalPolicy &&
      evidence.turnContext.sandboxMode === args.expected.sandboxMode &&
      (args.expected.approvalsReviewer === undefined ||
        evidence.turnContext.approvalsReviewer === args.expected.approvalsReviewer);
    return result("codex", args.check, ok, {
      sessionId: session.id,
      providerSessionId: session.providerSessionId,
      marker,
      selectedMode: args.mode,
      expected: args.expected,
      configuredMode: summarizeMode(configured),
      ...evidence,
    });
  } finally {
    await maybeCloseSession(session);
  }
}

async function runCodexOutsideWriteCase(args: {
  mode: SessionModeDescriptor;
  check: string;
  expected: "approval_required" | "file_created";
}): Promise<ProbeResult> {
  const dirs = await createPermissionProbeDirs(`codex-${args.check}`);
  const marker = `RAH_CODEX_PERMISSION_${args.expected}_${Date.now()}`;
  const targetFile = path.join(dirs.outsideDir, `${marker}.txt`);
  const session = await startSession({
    provider: "codex",
    title: `RAH Codex ${args.check}`,
    clientSlug: `codex-${args.check}`,
    cwd: dirs.workspaceDir,
  });
  try {
    await setSessionModel(session.id, {
      model: codexModel,
      optionKey: "model_reasoning_effort",
      reasoning: "low",
    });
    const configured = await setMode(session.id, args.mode.id);
    await sendInput(
      session.id,
      [
        marker,
        `Create exactly one file at this absolute path: ${targetFile}`,
        `The file content must be exactly: ${marker}`,
        "Do not modify any other file.",
        "If current permissions require approval, request approval and stop.",
      ].join("\n"),
      session.probeClientId,
    );
    const observation = await waitForPermissionOrFile(session.id, targetFile, permissionProbeTimeoutMs);
    const evidence = await readCodexEvidence(session.providerSessionId, marker);
    const content = await readFileIfExists(targetFile);
    const approvalObserved =
      observation.waitingPermission || evidence.permissionRequested || evidence.approvalMentioned;
    const modeOk =
      args.mode.role === "full_auto"
        ? evidence.turnContext.approvalPolicy === "never" &&
          evidence.turnContext.sandboxMode === "danger-full-access"
        : evidence.turnContext.approvalPolicy === "on-request" &&
          evidence.turnContext.sandboxMode === "workspace-write";
    const behaviorOk =
      args.expected === "file_created"
        ? observation.fileExists && content?.trim() === marker
        : !observation.fileExists && approvalObserved;
    return result("codex", args.check, modeOk && behaviorOk, {
      sessionId: session.id,
      providerSessionId: session.providerSessionId,
      marker,
      selectedMode: args.mode,
      targetFile,
      expected: args.expected,
      observed: {
        ...observation,
        contentPreview: content?.slice(0, 200) ?? null,
        approvalObserved,
      },
      configuredMode: summarizeMode(configured),
      ...evidence,
    });
  } finally {
    await maybeCloseSession(session);
    await cleanupPermissionProbeDirs(dirs);
  }
}

async function runOpenCodeProbe(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  if (!skipModelEffortProbes) {
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
  } else {
    results.push(
      result("opencode", "model-effort-probes-skipped", true, {
        skipped: true,
        reason: "RAH_SESSION_CONTROL_SKIP_MODEL_EFFORT_PROBES=1",
      }),
    );
  }
  if (!skipPermissionProbes) {
    results.push(...(await runOpenCodeAgentProbe()));
  }
  return results;
}

async function runClaudeProbe(): Promise<ProbeResult[]> {
  if (skipPermissionProbes) {
    return [
      result("claude", "permission-mode-probes-skipped", true, {
        skipped: true,
        reason: "RAH_SESSION_CONTROL_SKIP_PERMISSION_PROBES=1",
      }),
    ];
  }
  const catalog = await listProviderModelCatalog("claude");
  const modes = normalizeModes(catalog.modes);
  const planMode = selectModeByRole(modes, "plan");
  const acceptEditsMode = selectModeByRole(modes, "auto_edit");
  const bypassMode = selectModeByRole(modes, "full_auto");
  const results: ProbeResult[] = [];
  if (planMode) {
    results.push(
      await runClaudeFileWriteModeCase({
        mode: planMode,
        check: "permission-plan-blocks-file-write",
        expected: "file_absent",
      }),
    );
  } else {
    results.push(missingModeResult("claude", "permission-plan-blocks-file-write", "plan", { catalog }));
  }
  if (acceptEditsMode) {
    results.push(
      await runClaudeFileWriteModeCase({
        mode: acceptEditsMode,
        check: "permission-accept-edits-allows-file-write",
        expected: "file_created",
      }),
    );
  } else {
    results.push(missingModeResult("claude", "permission-accept-edits-allows-file-write", "auto_edit", { catalog }));
  }
  if (bypassMode) {
    results.push(
      await runClaudeFileWriteModeCase({
        mode: bypassMode,
        check: "permission-bypass-allows-file-write",
        expected: "file_created",
      }),
    );
  } else {
    results.push(missingModeResult("claude", "permission-bypass-allows-file-write", "full_auto", { catalog }));
  }
  return results;
}

async function runClaudeFileWriteModeCase(args: {
  mode: SessionModeDescriptor;
  check: string;
  expected: "file_created" | "file_absent";
}): Promise<ProbeResult> {
  const dirs = await createPermissionProbeDirs(`claude-${args.check}`);
  const marker = `RAH_CLAUDE_PERMISSION_${args.mode.id}_${Date.now()}`;
  const targetFile = path.join(dirs.workspaceDir, `${marker}.txt`);
  const session = await startSession({
    provider: "claude",
    title: `RAH Claude ${args.check}`,
    clientSlug: `claude-${args.check}`,
    cwd: dirs.workspaceDir,
    modeId: args.mode.id,
    ...(claudeProbeModel ? { model: claudeProbeModel } : {}),
    initialPrompt: [
      marker,
      `You are being tested in Claude permission mode ${args.mode.id}.`,
      `Create exactly one file at this absolute path: ${targetFile}`,
      `The file content must be exactly: ${marker}`,
      "Do not modify any other file.",
      "If the current mode prevents edits, say that clearly and do not fabricate success.",
    ].join("\n"),
    waitForIdle: false,
  });
  try {
    const observation = await waitForFileOrClaudeEvidence(
      session,
      marker,
      targetFile,
      permissionProbeTimeoutMs,
    );
    const content = await readFileIfExists(targetFile);
    const evidence = await readClaudeEvidence(session.providerSessionId, marker).catch((error) => ({
      error: readError(error),
    }));
    const fileCreated = content?.trim() === marker;
    const behaviorOk =
      args.expected === "file_created" ? fileCreated : !fileCreated && observation.evidenceSeen;
    return result("claude", args.check, behaviorOk, {
      sessionId: session.id,
      providerSessionId: session.providerSessionId,
      marker,
      selectedMode: args.mode,
      targetFile,
      expected: args.expected,
      observed: {
        ...observation,
        fileCreated,
        contentPreview: content?.slice(0, 200) ?? null,
      },
      sessionMode: summarizeMode(await getSession(session.id)),
      evidence,
    });
  } finally {
    await maybeCloseSession(session);
    await cleanupPermissionProbeDirs(dirs);
  }
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

async function runOpenCodeAgentProbe(): Promise<ProbeResult[]> {
  const catalog = await listProviderModelCatalog("opencode");
  const launchModes = selectOpenCodeAgentProbeModes(catalog.modes);
  if (launchModes.length === 0) {
    return [
      missingModeResult("opencode", "agent-dynamic-selection", "custom", {
        catalog,
        reason: "OpenCode did not expose any selectable agent modes.",
      }),
    ];
  }
  const session = await startSession({
    provider: "opencode",
    title: "RAH OpenCode agent probe",
    clientSlug: "opencode-agent",
    modeId: launchModes[0]?.id,
  });
  try {
    await setSessionModel(session.id, {
      model: opencodeGrokModel,
      optionKey: "model_reasoning_variant",
      reasoning: "low",
    });
    const sessionModes = mergeModes(catalog.modes, (await getSession(session.id)).mode?.availableModes);
    const modes = selectOpenCodeAgentProbeModes(sessionModes);
    if (modes.length === 0) {
      return [
        missingModeResult("opencode", "agent-dynamic-selection", "custom", {
          catalog,
          sessionMode: summarizeMode(await getSession(session.id)),
        }),
      ];
    }
    const results: ProbeResult[] = [];
    for (const mode of modes) {
      const marker = `RAH_OPENCODE_SESSION_CONTROL_AGENT_${mode.id.replace(/[^a-z0-9]+/gi, "_")}_${Date.now()}`;
      const configured = await setMode(session.id, mode.id);
      await sendInput(
        session.id,
        `${marker}\nReply with the marker only. Do not describe your agent, mode, model, or tools.`,
        session.probeClientId,
      );
      const evidence = await readOpenCodeEvidence(await getSession(session.id), marker);
      results.push(
        result(
          "opencode",
          `agent-${mode.id}`,
          evidence.assistant.mode === mode.id && evidence.assistant.agent === mode.id,
          {
            sessionId: session.id,
            providerSessionId: session.providerSessionId,
            marker,
            selectedMode: mode,
            configuredMode: summarizeMode(configured),
            ...evidence,
          },
        ),
      );
    }
    return results;
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
  cwd?: string;
  modeId?: string;
  model?: string;
  optionKey?: string;
  reasoning?: string;
  initialPrompt?: string;
  waitForIdle?: boolean;
}): Promise<ProbeSession> {
  const clientId = `${clientPrefix}-${args.clientSlug}`;
  const optionValues =
    args.optionKey && args.reasoning !== undefined
      ? { [args.optionKey]: args.reasoning }
      : undefined;
  const liveBackend = liveBackendForProvider(args.provider);
  const response = await requestJson<{ session: { session?: SessionSummary } | SessionSummary }>(
    `${baseUrl}/api/sessions/start`,
    {
      method: "POST",
      body: {
        provider: args.provider,
        cwd: args.cwd ?? workspace,
        ...(liveBackend ? { liveBackend } : {}),
        title: args.title,
        ...(args.model ? { model: args.model } : {}),
        ...(args.reasoning !== undefined ? { reasoningId: args.reasoning } : {}),
        ...(optionValues ? { optionValues } : {}),
        ...(args.modeId ? { modeId: args.modeId } : {}),
        ...(args.initialPrompt ? { initialPrompt: args.initialPrompt } : {}),
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
  if (args.waitForIdle !== false) {
    await waitSessionIdle(session.id);
  }
  await attachSession(session.id, clientId);
  return { ...(await getSession(session.id)), probeClientId: clientId };
}

function liveBackendForProvider(provider: Provider): "native_local_server" | "tui_mux" {
  return provider === "claude" ? "tui_mux" : "native_local_server";
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

function belongsToWorkspace(candidate: string | undefined, workspaceDir: string): boolean {
  if (!candidate) {
    return false;
  }
  const normalizedCandidate = path.resolve(candidate);
  const normalizedWorkspace = path.resolve(workspaceDir);
  return normalizedCandidate === normalizedWorkspace ||
    normalizedCandidate.startsWith(`${normalizedWorkspace}${path.sep}`);
}

async function closeLiveSessionsForWorkspace(workspaceDir: string): Promise<void> {
  const response = await requestJson<{
    sessions?: Array<{
      session?: SessionSummary;
      controlLease?: { holderClientId?: string };
      attachedClients?: Array<{ id?: string }>;
    }>;
  }>(`${baseUrl}/api/sessions`).catch(() => ({ sessions: [] }));
  for (const entry of response.sessions ?? []) {
    const summary = entry.session;
    if (!summary?.id || !belongsToWorkspace(summary.rootDir ?? summary.cwd, workspaceDir)) {
      continue;
    }
    const clientId =
      entry.controlLease?.holderClientId ??
      entry.attachedClients?.find((client) => typeof client.id === "string")?.id ??
      sharedWebClientId;
    try {
      await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(summary.id)}/close`, {
        method: "POST",
        body: { clientId },
      });
    } catch {
      // best effort cleanup
    }
  }
}

async function cleanupProbeWorkspace(workspaceDir: string, physicalRoot = workspaceDir): Promise<void> {
  await closeLiveSessionsForWorkspace(workspaceDir);
  try {
    await requestJson(`${baseUrl}/api/history/workspaces/remove`, {
      method: "POST",
      body: { dir: workspaceDir },
    });
  } catch {
    // best effort cleanup
  }
  try {
    await requestJson(`${baseUrl}/api/workspaces/remove`, {
      method: "POST",
      body: { dir: workspaceDir },
    });
  } catch {
    // best effort cleanup
  }
  await movePathToTrashIfExists(physicalRoot);
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
  let permissionRequested = false;
  let approvalMentioned = false;

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
    const payloadText = JSON.stringify(payload);
    if (
      payload.type === "permission_requested" ||
      payload.type === "approval_request" ||
      payload.type === "exec_approval_request" ||
      payload.type === "apply_patch_approval_request"
    ) {
      permissionRequested = true;
    }
    if (/approval|permission/i.test(payloadText)) {
      approvalMentioned = true;
    }
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

  if (!markerSeen || !selectedTurnContext) {
    return null;
  }

  const collaborationMode = isRecord(selectedTurnContext.collaboration_mode)
    ? String(selectedTurnContext.collaboration_mode.mode ?? "")
    : "";
  const collaborationSettings = isRecord(selectedTurnContext.collaboration_mode)
    ? selectedTurnContext.collaboration_mode.settings
    : undefined;
  const settings = isRecord(collaborationSettings) ? collaborationSettings : {};
  const sandboxPolicy = isRecord(selectedTurnContext.sandbox_policy)
    ? selectedTurnContext.sandbox_policy
    : undefined;
  return {
    marker,
    turnContext: {
      turnId: selectedTurnContext.turn_id,
      model: selectedTurnContext.model,
      effort: selectedTurnContext.effort,
      collaborationMode,
      collaborationReasoning: settings.reasoning_effort,
      approvalPolicy:
        selectedTurnContext.approval_policy ??
        settings.approval_policy ??
        settings.approvalPolicy,
      sandboxMode:
        sandboxPolicy?.type ??
        selectedTurnContext.sandbox_mode ??
        settings.sandbox_mode ??
        settings.sandboxMode,
      approvalsReviewer:
        selectedTurnContext.approvals_reviewer ??
        settings.approvals_reviewer ??
        settings.approvalsReviewer,
    },
    lastTokenUsage: lastTokenUsage ?? {},
    taskComplete,
    permissionRequested,
    approvalMentioned,
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

async function readClaudeEvidence(providerSessionId: string | undefined, marker: string) {
  assertNonEmpty(providerSessionId, "Claude provider session id");
  const file = await waitForClaudeTranscript(providerSessionId);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const evidence = await parseClaudeTranscript(file, marker);
    if (evidence) {
      return { file, ...evidence };
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for Claude marker ${marker} in ${file}.`);
}

async function waitForClaudeTranscript(providerSessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const found = await findClaudeTranscript(providerSessionId);
    if (found) {
      return found;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Claude transcript ${providerSessionId}.`);
}

async function tryReadClaudeEvidence(providerSessionId: string | undefined, marker: string) {
  if (!providerSessionId) {
    return null;
  }
  const file = await findClaudeTranscript(providerSessionId);
  if (!file) {
    return null;
  }
  const evidence = await parseClaudeTranscript(file, marker);
  return evidence ? { file, ...evidence } : null;
}

async function findClaudeTranscript(providerSessionId: string): Promise<string | null> {
  const roots = [
    ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : []),
    path.join(os.homedir(), ".claude"),
  ];
  for (const root of roots) {
    const found = await findFile(root, (file) => {
      return path.basename(file) === `${providerSessionId}.jsonl`;
    });
    if (found) {
      return found;
    }
  }
  return null;
}

async function parseClaudeTranscript(file: string, marker: string) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  let markerSeen = false;
  const toolNames: string[] = [];
  const assistantTexts: string[] = [];
  let userRecordId: string | undefined;

  for (const line of lines) {
    const record = parseJson(line);
    if (!record) {
      continue;
    }
    const text = extractText(record);
    if (!markerSeen && text.includes(marker)) {
      markerSeen = true;
      userRecordId = typeof record.uuid === "string" ? record.uuid : undefined;
      continue;
    }
    if (!markerSeen) {
      continue;
    }
    if (record.type === "user" && text.includes(marker)) {
      continue;
    }
    if (record.type === "assistant") {
      assistantTexts.push(text);
      toolNames.push(...extractClaudeToolNames(record));
    }
  }

  if (!markerSeen || (assistantTexts.join("").trim().length === 0 && toolNames.length === 0)) {
    return null;
  }
  return {
    marker,
    userRecordId,
    assistantTextPreview: assistantTexts.join("\n").slice(0, 800),
    toolNames,
  };
}

function extractClaudeToolNames(record: JsonRecord): string[] {
  const message = recordField(record, "message");
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "tool_use") {
      return [];
    }
    const name = typeof block.name === "string" ? block.name : "unknown";
    return [name];
  });
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const key of ["text", "content"]) {
    const text = extractText(value[key]);
    if (text) {
      parts.push(text);
    }
  }
  if (isRecord(value.message)) {
    const text = extractText(value.message);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

type PermissionProbeDirs = {
  root: string;
  workspaceDir: string;
  outsideDir: string;
};

async function createPermissionProbeDirs(label: string): Promise<PermissionProbeDirs> {
  const root = await mkdtemp(path.join(os.tmpdir(), `rah-session-control-${label}-`));
  const workspaceDir = path.join(root, "workspace");
  const outsideDir = path.join(root, "outside");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  return { root, workspaceDir, outsideDir };
}

async function cleanupPermissionProbeDirs(dirs: PermissionProbeDirs): Promise<void> {
  if (keepSessions) {
    return;
  }
  await cleanupProbeWorkspace(dirs.workspaceDir, dirs.root);
}

async function waitForPermissionOrFile(
  sessionId: string,
  file: string,
  timeoutMs: number,
): Promise<{
  fileExists: boolean;
  waitingPermission: boolean;
  finalRuntimeState?: string;
  finalActiveTurnId?: string | null;
}> {
  const start = Date.now();
  let latest: SessionSummary | null = null;
  while (Date.now() - start < timeoutMs) {
    if (await fileExists(file)) {
      latest = await getSession(sessionId).catch(() => latest);
      return {
        fileExists: true,
        waitingPermission: false,
        finalRuntimeState: latest?.runtimeState,
        finalActiveTurnId: latest?.activeTurnId,
      };
    }
    latest = await getSession(sessionId);
    if (latest.runtimeState === "waiting_permission") {
      return {
        fileExists: false,
        waitingPermission: true,
        finalRuntimeState: latest.runtimeState,
        finalActiveTurnId: latest.activeTurnId,
      };
    }
    await delay(1_000);
  }
  return {
    fileExists: await fileExists(file),
    waitingPermission: false,
    finalRuntimeState: latest?.runtimeState,
    finalActiveTurnId: latest?.activeTurnId,
  };
}

async function waitForFileOrClaudeEvidence(
  session: SessionSummary,
  marker: string,
  file: string,
  timeoutMs: number,
): Promise<{
  fileExists: boolean;
  evidenceSeen: boolean;
  finalRuntimeState?: string;
  finalActiveTurnId?: string | null;
}> {
  const start = Date.now();
  let latest: SessionSummary | null = null;
  while (Date.now() - start < timeoutMs) {
    if (await fileExists(file)) {
      latest = await getSession(session.id).catch(() => latest);
      return {
        fileExists: true,
        evidenceSeen: true,
        finalRuntimeState: latest?.runtimeState,
        finalActiveTurnId: latest?.activeTurnId,
      };
    }
    const evidence = await tryReadClaudeEvidence(session.providerSessionId, marker);
    if (evidence) {
      latest = await getSession(session.id).catch(() => latest);
      return {
        fileExists: false,
        evidenceSeen: true,
        finalRuntimeState: latest?.runtimeState,
        finalActiveTurnId: latest?.activeTurnId,
      };
    }
    latest = await getSession(session.id).catch(() => latest);
    await delay(1_500);
  }
  return {
    fileExists: await fileExists(file),
    evidenceSeen: false,
    finalRuntimeState: latest?.runtimeState,
    finalActiveTurnId: latest?.activeTurnId,
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function unwrapSession(value: { session?: SessionSummary } | SessionSummary): SessionSummary {
  if ("session" in value && value.session) {
    return value.session;
  }
  return value as SessionSummary;
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

function missingModeResult(
  provider: Provider,
  check: string,
  requiredRole: string,
  evidence: JsonRecord,
): ProbeResult {
  return result(provider, check, false, {
    requiredRole,
    reason: "Provider did not expose a selectable mode with the required role.",
    ...evidence,
  });
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

function summarizeMode(session: SessionSummary): JsonRecord {
  return {
    currentModeId: session.mode?.currentModeId,
    modeMutable: session.mode?.mutable,
    modeSource: session.mode?.source,
    availableModes: session.mode?.availableModes?.map((mode) => ({
      id: mode.id,
      role: mode.role,
    })),
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
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      const rawPreview = text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text;
      if (!response.ok) {
        throw new Error(
          `${options?.method ?? "GET"} ${url} -> ${response.status}: ${rawPreview}`,
        );
      }
      throw new Error(
        `${options?.method ?? "GET"} ${url} returned invalid JSON: ${readError(error)}\n${rawPreview}`,
      );
    }
  }
  if (!response.ok) {
    throw new Error(`${options?.method ?? "GET"} ${url} -> ${response.status}: ${text}`);
  }
  return body as T;
}

async function findFile(
  dir: string,
  predicate: (file: string) => boolean,
): Promise<string | null> {
  let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
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
