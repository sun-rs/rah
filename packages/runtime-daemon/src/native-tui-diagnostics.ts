import type {
  NativeTuiDiagnostic,
  NativeTuiDiagnosticKind,
  NativeTuiDiagnosticSeverity,
  ProviderKind,
} from "@rah/runtime-protocol";

const DEFAULT_DIAGNOSTIC_LIMIT = 200;

type DiagnosticDetails = NonNullable<NativeTuiDiagnostic["details"]>;

export type NativeTuiDiagnosticInput = {
  sessionId: string;
  provider: ProviderKind;
  providerSessionId?: string;
  kind: NativeTuiDiagnosticKind;
  severity: NativeTuiDiagnosticSeverity;
  message: string;
  cwd: string;
  elapsedMs?: number;
  details?: DiagnosticDetails;
};

export type ListNativeTuiDiagnosticsOptions = {
  sessionId?: string;
  includeResolved?: boolean;
};

type NativeTuiDiagnosticSession = {
  sessionId: string;
  provider: ProviderKind;
  providerSessionId?: string;
  cwd: string;
  startupTimestampMs: number;
};

type NativeTuiDiagnosticLogger = Pick<typeof console, "warn">;

function diagnosticKey(sessionId: string, kind: NativeTuiDiagnosticKind): string {
  return `native-tui:${sessionId}:${kind}`;
}

function mergeDetails(
  existing: DiagnosticDetails | undefined,
  incoming: DiagnosticDetails | undefined,
): DiagnosticDetails | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  return {
    ...(existing ?? {}),
    ...(incoming ?? {}),
  };
}

export class NativeTuiDiagnosticStore {
  private readonly diagnostics = new Map<string, NativeTuiDiagnostic>();

  constructor(private readonly limit = DEFAULT_DIAGNOSTIC_LIMIT) {}

  list(options: ListNativeTuiDiagnosticsOptions = {}): NativeTuiDiagnostic[] {
    const includeResolved = options.includeResolved === true;
    return [...this.diagnostics.values()]
      .filter((diagnostic) => !options.sessionId || diagnostic.sessionId === options.sessionId)
      .filter((diagnostic) => includeResolved || diagnostic.status === "active")
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      )
      .map((diagnostic) => ({ ...diagnostic }));
  }

  upsert(input: NativeTuiDiagnosticInput): NativeTuiDiagnostic {
    const id = diagnosticKey(input.sessionId, input.kind);
    const existing = this.diagnostics.get(id);
    const now = new Date().toISOString();
    const details = mergeDetails(existing?.details, input.details);
    const next: NativeTuiDiagnostic = {
      id,
      sessionId: input.sessionId,
      provider: input.provider,
      kind: input.kind,
      severity: input.severity,
      status: "active",
      message: input.message,
      cwd: input.cwd,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
      ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
      ...(details ? { details } : {}),
    };
    this.diagnostics.set(id, next);
    this.prune();
    return { ...next };
  }

  resolve(
    sessionId: string,
    kind: NativeTuiDiagnosticKind,
    options: {
      providerSessionId?: string;
      details?: DiagnosticDetails;
    } = {},
  ): NativeTuiDiagnostic | undefined {
    const id = diagnosticKey(sessionId, kind);
    const existing = this.diagnostics.get(id);
    if (!existing) {
      return undefined;
    }
    const now = new Date().toISOString();
    const details = mergeDetails(existing.details, options.details);
    const next: NativeTuiDiagnostic = {
      ...existing,
      status: "resolved",
      updatedAt: now,
      resolvedAt: now,
      ...(options.providerSessionId ? { providerSessionId: options.providerSessionId } : {}),
      ...(details ? { details } : {}),
    };
    this.diagnostics.set(id, next);
    return { ...next };
  }

  clearSession(sessionId: string): void {
    for (const diagnostic of this.diagnostics.values()) {
      if (diagnostic.sessionId === sessionId && diagnostic.status === "active") {
        this.resolve(sessionId, diagnostic.kind, {
          details: { resolution: "session_closed" },
        });
      }
    }
  }

  private prune(): void {
    if (this.diagnostics.size <= this.limit) {
      return;
    }
    const removable = [...this.diagnostics.values()]
      .filter((diagnostic) => diagnostic.status === "resolved")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const diagnostic of removable) {
      if (this.diagnostics.size <= this.limit) {
        return;
      }
      this.diagnostics.delete(diagnostic.id);
    }
  }
}

export function recordNativeTuiProcessExitDiagnostic(
  store: NativeTuiDiagnosticStore,
  session: NativeTuiDiagnosticSession,
  exitArgs: { exitCode?: number; signal?: string },
): void {
  const hasFailureExitCode = exitArgs.exitCode !== undefined && exitArgs.exitCode !== 0;
  store.upsert({
    sessionId: session.sessionId,
    provider: session.provider,
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    kind: "process_exited",
    severity: hasFailureExitCode || exitArgs.signal ? "warning" : "info",
    message:
      hasFailureExitCode || exitArgs.signal
        ? "Native TUI process exited before the session was closed."
        : "Native TUI process exited and the session was stopped.",
    cwd: session.cwd,
    details: {
      ...(exitArgs.exitCode !== undefined ? { exitCode: exitArgs.exitCode } : {}),
      ...(exitArgs.signal ? { signal: exitArgs.signal } : {}),
    },
  });
}

export function maybeRecordNativeTuiBindingMissingDiagnostic(
  store: NativeTuiDiagnosticStore,
  session: NativeTuiDiagnosticSession,
  thresholdMs: number,
  options: { nowMs?: number; logger?: NativeTuiDiagnosticLogger } = {},
): boolean {
  const elapsedMs = (options.nowMs ?? Date.now()) - session.startupTimestampMs;
  if (elapsedMs < thresholdMs) {
    return false;
  }
  store.upsert({
    sessionId: session.sessionId,
    provider: session.provider,
    kind: "binding_missing",
    severity: "warning",
    message: "Native TUI provider session is still unbound.",
    cwd: session.cwd,
    elapsedMs,
    details: { thresholdMs },
  });
  (options.logger ?? console).warn("[rah] native TUI provider session is still unbound", {
    provider: session.provider,
    sessionId: session.sessionId,
    cwd: session.cwd,
    elapsedMs,
  });
  return true;
}

export function resolveNativeTuiBindingDiagnostic(
  store: NativeTuiDiagnosticStore,
  sessionId: string,
  providerSessionId: string,
): void {
  store.resolve(sessionId, "binding_missing", {
    providerSessionId,
    details: { resolution: "provider_session_bound" },
  });
}

export function resolveNativeTuiMirrorSourceDiagnostic(
  store: NativeTuiDiagnosticStore,
  session: NativeTuiDiagnosticSession,
): void {
  store.resolve(session.sessionId, "mirror_source_missing", {
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    details: { resolution: "mirror_source_available" },
  });
}

export function resolveNativeTuiMirrorFailureDiagnostic(
  store: NativeTuiDiagnosticStore,
  session: NativeTuiDiagnosticSession,
): boolean {
  return (
    store.resolve(session.sessionId, "mirror_failed", {
      ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
      details: { resolution: "mirror_update_succeeded" },
    }) !== undefined
  );
}

export function maybeRecordNativeTuiMirrorSourceMissingDiagnostic(
  store: NativeTuiDiagnosticStore,
  session: NativeTuiDiagnosticSession,
  thresholdMs: number,
  options: { nowMs?: number; logger?: NativeTuiDiagnosticLogger } = {},
): boolean {
  const elapsedMs = (options.nowMs ?? Date.now()) - session.startupTimestampMs;
  if (elapsedMs < thresholdMs) {
    return false;
  }
  store.upsert({
    sessionId: session.sessionId,
    provider: session.provider,
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    kind: "mirror_source_missing",
    severity: "warning",
    message: "Native TUI chat mirror source is still unavailable.",
    cwd: session.cwd,
    elapsedMs,
    details: { thresholdMs },
  });
  (options.logger ?? console).warn("[rah] native TUI chat mirror source is still unavailable", {
    provider: session.provider,
    sessionId: session.sessionId,
    providerSessionId: session.providerSessionId,
    cwd: session.cwd,
    elapsedMs,
  });
  return true;
}

export function recordNativeTuiMirrorFailureDiagnostic(
  store: NativeTuiDiagnosticStore,
  session: NativeTuiDiagnosticSession,
  error: unknown,
  phase: string,
  options: { alreadyLogged?: boolean; nowMs?: number; logger?: NativeTuiDiagnosticLogger } = {},
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const elapsedMs = (options.nowMs ?? Date.now()) - session.startupTimestampMs;
  store.upsert({
    sessionId: session.sessionId,
    provider: session.provider,
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    kind: "mirror_failed",
    severity: "warning",
    message: "Native TUI chat mirror failed to update.",
    cwd: session.cwd,
    elapsedMs,
    details: {
      phase,
      error: message,
    },
  });
  if (options.alreadyLogged) {
    return false;
  }
  (options.logger ?? console).warn("[rah] native TUI chat mirror failed to update", {
    provider: session.provider,
    sessionId: session.sessionId,
    providerSessionId: session.providerSessionId,
    cwd: session.cwd,
    phase,
    error: message,
  });
  return true;
}
