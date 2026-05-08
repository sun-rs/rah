import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderKind, StartSessionRequest } from "@rah/runtime-protocol";
import { RuntimeEngine } from "../packages/runtime-daemon/src/runtime-engine";
import { ZellijMuxBackend } from "../packages/runtime-daemon/src/zellij-mux-backend";

type ProbeProvider = Extract<ProviderKind, "codex" | "claude" | "opencode">;

type ProviderProbeResult = {
  provider: ProbeProvider;
  ok: boolean;
  cwd: string;
  socketDir: string;
  sessionId?: string;
  providerSessionId?: string;
  zellijSessionName?: string;
  zellijPaneId?: string;
  launchPreview?: string;
  diagnosticsObserved: boolean;
  paneObserved: boolean;
  dumpObserved: boolean;
  dumpVisibleObserved: boolean;
  ptyOutputObserved: boolean;
  ptyVisibleObserved: boolean;
  dumpBytes: number;
  ptyOutputBytes: number;
  paneExitedBeforeClose?: boolean;
  exitProbeEnabled?: boolean;
  exitInputSent?: boolean;
  exitInputBytes?: number;
  rahSessionGoneAfterExit?: boolean;
  zellijSessionGoneAfterExit?: boolean;
  paneExitedAfterExit?: boolean;
  closeError?: string;
  zellijSessionGoneAfterClose: boolean;
  zellijSessionGoneAfterFallback: boolean;
  outputPreview: string;
  error?: string;
};

type RahProbeMetadata = {
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
};

const SELECTABLE_PROVIDERS: ProbeProvider[] = ["codex", "claude", "opencode"];
const DEFAULT_PROVIDERS: ProbeProvider[] = ["codex", "claude", "opencode"];

const SETTLE_MS = Number(process.env.RAH_ZELLIJ_REAL_TUI_PROBE_SETTLE_MS ?? 8_000);
const CLOSE_TIMEOUT_MS = Number(process.env.RAH_ZELLIJ_REAL_TUI_PROBE_CLOSE_TIMEOUT_MS ?? 5_000);
const EXIT_WAIT_MS = Number(process.env.RAH_ZELLIJ_REAL_TUI_PROBE_EXIT_WAIT_MS ?? 6_000);
const EXIT_PROBE = process.env.RAH_ZELLIJ_REAL_TUI_PROBE_EXIT === "1";
const EXIT_INPUT = process.env.RAH_ZELLIJ_REAL_TUI_PROBE_EXIT_INPUT ?? "/exit\r";
const ALLOW_FAILURES = process.env.RAH_ZELLIJ_REAL_TUI_PROBE_ALLOW_FAILURES === "1";
const OUTPUT_PATH = process.env.RAH_ZELLIJ_REAL_TUI_PROBE_OUTPUT?.trim() || null;
const WORKSPACE_ROOT =
  process.env.RAH_ZELLIJ_REAL_TUI_PROBE_WORKSPACE_ROOT?.trim() ||
  join(process.cwd(), "test-results", "zellij-real-tui-workspaces");
const SOCKET_ROOT =
  process.env.RAH_ZELLIJ_REAL_TUI_PROBE_SOCKET_ROOT?.trim() ||
  "/tmp/rah-zellij-real-probe";
const RAH_HOME_ROOT =
  process.env.RAH_ZELLIJ_REAL_TUI_PROBE_RAH_HOME_ROOT?.trim() ||
  join(process.cwd(), "test-results", "zellij-real-tui-rah-home");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedProviders(): ProbeProvider[] {
  const raw = process.env.RAH_ZELLIJ_REAL_TUI_PROBE_PROVIDERS?.trim();
  if (!raw) {
    return DEFAULT_PROVIDERS;
  }
  const selected = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const unknown = selected.filter(
    (provider): provider is string => !SELECTABLE_PROVIDERS.includes(provider as ProbeProvider),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown provider(s): ${unknown.join(", ")}`);
  }
  return selected as ProbeProvider[];
}

function normalizeOutput(output: string): string {
  return output
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[78]/g, "")
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function previewOutput(...parts: string[]): string {
  const normalized = normalizeOutput(parts.filter(Boolean).join("\n\n---\n\n"));
  return normalized.length <= 1_600 ? normalized : `${normalized.slice(0, 1_600)}...`;
}

function readGitField(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function readRahMetadata(): RahProbeMetadata {
  const status = readGitField(["status", "--short"]);
  return {
    branch: readGitField(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: readGitField(["rev-parse", "--short", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    changedFiles: status === null || status.length === 0 ? 0 : status.split(/\r?\n/).length,
  };
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function writeReport(reportPath: string | null, report: unknown): void {
  if (!reportPath) {
    return;
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function setEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

async function closeEngineSession(
  engine: RuntimeEngine,
  sessionId: string,
  clientId: string,
): Promise<string | undefined> {
  return await timeout(
    engine.closeSession(sessionId, { clientId }),
    CLOSE_TIMEOUT_MS,
    "zellij TUI close",
  ).then(
    () => undefined,
    (error) => {
      return error instanceof Error ? error.message : String(error);
    },
  );
}

async function waitForZellijSessionGone(
  zellij: ZellijMuxBackend,
  sessionName: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!sessionName) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = await zellij.listSessions().catch(() => []);
    if (!sessions.some((session) => session.sessionName === sessionName)) {
      return true;
    }
    await sleep(50);
  }
  const sessions = await zellij.listSessions().catch(() => []);
  return !sessions.some((session) => session.sessionName === sessionName);
}

async function waitForRahSessionGone(
  engine: RuntimeEngine,
  sessionId: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!sessionId) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      engine.getSessionSummary(sessionId);
    } catch {
      return true;
    }
    await sleep(50);
  }
  try {
    engine.getSessionSummary(sessionId);
    return false;
  } catch {
    return true;
  }
}

async function waitForManagedPane(
  engine: RuntimeEngine,
  sessionId: string | undefined,
  paneId: string | undefined,
  timeoutMs: number,
): Promise<{
  diagnostic?: Awaited<ReturnType<RuntimeEngine["listZellijMuxDiagnostics"]>>[number];
  pane?: Awaited<ReturnType<RuntimeEngine["listZellijMuxDiagnostics"]>>[number]["panes"][number];
}> {
  if (!sessionId || !paneId) {
    return {};
  }
  const deadline = Date.now() + timeoutMs;
  let last:
    | {
        diagnostic?: Awaited<ReturnType<RuntimeEngine["listZellijMuxDiagnostics"]>>[number];
        pane?: Awaited<ReturnType<RuntimeEngine["listZellijMuxDiagnostics"]>>[number]["panes"][number];
      }
    | undefined;
  while (Date.now() < deadline) {
    try {
      engine.getSessionSummary(sessionId);
    } catch {
      return last ?? {};
    }
    const diagnostics = await engine.listZellijMuxDiagnostics();
    const diagnostic = diagnostics.find((candidate) => candidate.managedSessionId === sessionId);
    const pane = diagnostic?.panes.find((candidate) => candidate.paneId === paneId);
    last = { ...(diagnostic ? { diagnostic } : {}), ...(pane ? { pane } : {}) };
    if (diagnostic && pane && !pane.exited) {
      return { diagnostic, pane };
    }
    await sleep(100);
  }
  return last ?? {};
}

async function probeProvider(provider: ProbeProvider): Promise<ProviderProbeResult> {
  const probeId = randomUUID();
  const cwd = join(WORKSPACE_ROOT, provider);
  const socketDir = join(SOCKET_ROOT, provider);
  const rahHome = join(RAH_HOME_ROOT, provider);
  rmSync(socketDir, { force: true, recursive: true });
  rmSync(rahHome, { force: true, recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(socketDir, { recursive: true });
  mkdirSync(rahHome, { recursive: true });

  const restoreRahHome = setEnv("RAH_HOME", rahHome);
  const restoreSocketDir = setEnv("RAH_ZELLIJ_SOCKET_DIR", socketDir);
  const engine = new RuntimeEngine();
  const zellij = new ZellijMuxBackend({ socketDir });
  const clientId = `web-zellij-probe-${probeId}`;
  let sessionId: string | undefined;
  let zellijSessionName: string | undefined;
  let zellijPaneId: string | undefined;
  let ptyOutput = "";

  try {
    const request: StartSessionRequest = {
      provider,
      cwd,
      liveBackend: "zellij_tui",
      title: `RAH real zellij TUI launch probe ${provider} ${probeId}`,
      attach: {
        client: {
          id: clientId,
          kind: "web",
          connectionId: clientId,
        },
        mode: "interactive",
        claimControl: true,
      },
    };
    const started = await engine.startSession(request);
    sessionId = started.session.session.id;
    zellijSessionName = started.session.session.mux?.sessionName;
    zellijPaneId = started.session.session.mux?.paneId;
    const unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
      if (frame.type === "pty.output") {
        ptyOutput += frame.data;
      } else if (frame.type === "pty.replay") {
        ptyOutput += frame.chunks.join("");
      }
    });

    await sleep(SETTLE_MS);

    const observed = await waitForManagedPane(
      engine,
      sessionId,
      zellijPaneId,
      Math.max(SETTLE_MS, 1_000),
    );
    const diagnostic = observed.diagnostic;
    const pane = observed.pane;
    const dumped =
      zellijSessionName && zellijPaneId
        ? await zellij
            .dumpScreen(zellijSessionName, zellijPaneId, { full: true, ansi: true })
            .catch(() => "")
        : "";

    let exitInputSent = false;
    let rahSessionGoneAfterExit = false;
    let zellijSessionGoneAfterExit = false;
    let paneExitedAfterExit: boolean | undefined;
    if (EXIT_PROBE && sessionId && zellijSessionName) {
      engine.getSessionSummary(sessionId);
      await engine.claimNativeTuiSurface(sessionId, {
        clientId,
        clientKind: "web",
        cols: 120,
        rows: 36,
      });
      engine.onPtyInput(sessionId, clientId, EXIT_INPUT);
      exitInputSent = true;
      rahSessionGoneAfterExit = await waitForRahSessionGone(engine, sessionId, EXIT_WAIT_MS);
      const panesAfterExit = await zellij.listPanes(zellijSessionName).catch(() => null);
      if (panesAfterExit === null) {
        paneExitedAfterExit = true;
      } else if (zellijPaneId) {
        const paneAfterExit = panesAfterExit.find(
          (candidate) => candidate.paneId === zellijPaneId,
        );
        paneExitedAfterExit = !paneAfterExit || paneAfterExit.exited;
      }
      zellijSessionGoneAfterExit = await waitForZellijSessionGone(
        zellij,
        zellijSessionName,
        CLOSE_TIMEOUT_MS,
      );
    }

    unsubscribe();
    let closeError: string | undefined;
    if (sessionId && !rahSessionGoneAfterExit) {
      closeError = await closeEngineSession(engine, sessionId, clientId);
    }
    const zellijSessionGoneAfterClose = rahSessionGoneAfterExit
      ? zellijSessionGoneAfterExit
      : await waitForZellijSessionGone(
          zellij,
          zellijSessionName,
          CLOSE_TIMEOUT_MS,
        );
    if (!zellijSessionGoneAfterClose && zellijSessionName) {
      await zellij.killSession(zellijSessionName).catch(() => undefined);
    }
    const zellijSessionGoneAfterFallback = await waitForZellijSessionGone(
      zellij,
      zellijSessionName,
      CLOSE_TIMEOUT_MS,
    );

    const ptyVisible = normalizeOutput(ptyOutput);
    const dumpVisible = normalizeOutput(dumped);
    const launchOk = Boolean(
      zellijSessionName &&
        zellijPaneId &&
        diagnostic &&
        pane &&
        !pane.exited &&
        !closeError &&
        zellijSessionGoneAfterClose,
    );
    const exitOk =
      !EXIT_PROBE ||
      Boolean(exitInputSent && rahSessionGoneAfterExit && zellijSessionGoneAfterExit);
    const ok = launchOk && exitOk;

    return {
      provider,
      ok,
      cwd,
      socketDir,
      sessionId,
      providerSessionId: started.session.session.providerSessionId,
      zellijSessionName,
      zellijPaneId,
      launchPreview: started.session.session.preview,
      diagnosticsObserved: Boolean(diagnostic),
      paneObserved: Boolean(pane),
      dumpObserved: dumped.trim().length > 0,
      dumpVisibleObserved: dumpVisible.length > 0,
      ptyOutputObserved: ptyOutput.trim().length > 0,
      ptyVisibleObserved: ptyVisible.length > 0,
      dumpBytes: Buffer.byteLength(dumped, "utf8"),
      ptyOutputBytes: Buffer.byteLength(ptyOutput, "utf8"),
      ...(pane ? { paneExitedBeforeClose: pane.exited } : {}),
      ...(EXIT_PROBE
        ? {
            exitProbeEnabled: true,
            exitInputSent,
            exitInputBytes: Buffer.byteLength(EXIT_INPUT, "utf8"),
            rahSessionGoneAfterExit,
            zellijSessionGoneAfterExit,
            ...(paneExitedAfterExit !== undefined ? { paneExitedAfterExit } : {}),
          }
        : {}),
      ...(closeError ? { closeError } : {}),
      zellijSessionGoneAfterClose,
      zellijSessionGoneAfterFallback,
      outputPreview: previewOutput(dumped, ptyOutput),
      ...(!ok
        ? {
            error: EXIT_PROBE
              ? "Zellij TUI exit probe did not observe RAH session and zellij session cleanup."
              : "Zellij TUI launch probe did not observe a healthy managed pane.",
          }
        : {}),
    };
  } catch (error) {
    if (sessionId) {
      await closeEngineSession(engine, sessionId, clientId);
    }
    if (zellijSessionName) {
      await zellij.killSession(zellijSessionName).catch(() => undefined);
    }
    return {
      provider,
      ok: false,
      cwd,
      socketDir,
      ...(sessionId ? { sessionId } : {}),
      ...(zellijSessionName ? { zellijSessionName } : {}),
      ...(zellijPaneId ? { zellijPaneId } : {}),
      diagnosticsObserved: false,
      paneObserved: false,
      dumpObserved: false,
      dumpVisibleObserved: false,
      ptyOutputObserved: ptyOutput.trim().length > 0,
      ptyVisibleObserved: normalizeOutput(ptyOutput).length > 0,
      dumpBytes: 0,
      ptyOutputBytes: Buffer.byteLength(ptyOutput, "utf8"),
      ...(EXIT_PROBE ? { exitProbeEnabled: true } : {}),
      zellijSessionGoneAfterClose: false,
      zellijSessionGoneAfterFallback: await waitForZellijSessionGone(
        zellij,
        zellijSessionName,
        CLOSE_TIMEOUT_MS,
      ),
      outputPreview: previewOutput(ptyOutput),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await engine.shutdown();
    restoreSocketDir();
    restoreRahHome();
  }
}

async function main(): Promise<void> {
  const providers = selectedProviders();
  const results: ProviderProbeResult[] = [];
  for (const provider of providers) {
    results.push(await probeProvider(provider));
  }
  const ok = results.every((result) => result.ok) || ALLOW_FAILURES;
  const report = {
    ok,
    settleMs: SETTLE_MS,
    rah: readRahMetadata(),
    asserted: [
      "real provider TUI launch request uses RAH zellij_tui backend",
      "zellij diagnostics can observe the managed provider pane",
      "zellij dump-screen can read the provider pane without using it as structured chat truth",
      "RAH archive/close removes the zellij session after the probe",
      ...(EXIT_PROBE
        ? [
            "RAH observes configured provider exit input and removes the live session plus zellij session",
          ]
        : []),
    ],
    results,
    notes: [
      "This probe launches real provider CLIs in zellij but does not send a model prompt.",
      "Set RAH_ZELLIJ_REAL_TUI_PROBE_EXIT=1 and optionally RAH_ZELLIJ_REAL_TUI_PROBE_EXIT_INPUT to test a provider-native exit key/command.",
      "It does not prove model response, Stop during a real turn, permissions, quota, login, long-running turn behavior, or iPad/Safari behavior.",
      "Providers may still create empty local metadata during startup.",
    ],
  };
  writeReport(OUTPUT_PATH, report);
  console.log(JSON.stringify(report, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
