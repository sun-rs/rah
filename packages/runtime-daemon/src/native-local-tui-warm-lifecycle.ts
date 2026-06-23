import type {
  NativeTuiSurfaceClaimRequest,
  NativeTuiSurfaceReleaseRequest,
  NativeTuiSurfaceState,
} from "@rah/runtime-protocol";

export const DEFAULT_NATIVE_LOCAL_TUI_IDLE_CLOSE_MS = 10 * 60 * 1000;

export type NativeLocalTuiWarmLease = NativeTuiSurfaceState & {
  surfaceId: string;
  lastSeenAtMs: number;
};

export type NativeLocalTuiWarmState = {
  leases: Map<string, NativeLocalTuiWarmLease>;
  idleSinceMs?: number;
  closeAfterMs?: number;
};

export function createNativeLocalTuiWarmState(): NativeLocalTuiWarmState {
  return { leases: new Map() };
}

export function nativeLocalTuiSurfaceKey(
  request: Pick<NativeTuiSurfaceClaimRequest, "clientId" | "surfaceId">,
): string {
  const surfaceId = request.surfaceId?.trim();
  return surfaceId || request.clientId;
}

export function claimNativeLocalTuiWarmLease(args: {
  state: NativeLocalTuiWarmState;
  sessionId: string;
  request: NativeTuiSurfaceClaimRequest;
  nowMs: number;
  attachedAt: string;
}): NativeLocalTuiWarmLease {
  const surfaceId = nativeLocalTuiSurfaceKey(args.request);
  const lease: NativeLocalTuiWarmLease = {
    sessionId: args.sessionId,
    surfaceId,
    clientId: args.request.clientId,
    clientKind: args.request.clientKind,
    ...(args.request.cols !== undefined
      ? { cols: Math.max(20, Math.floor(args.request.cols)) }
      : {}),
    ...(args.request.rows !== undefined
      ? { rows: Math.max(8, Math.floor(args.request.rows)) }
      : {}),
    attachedAt: args.attachedAt,
    lastSeenAtMs: args.nowMs,
  };
  args.state.leases.set(surfaceId, lease);
  delete args.state.idleSinceMs;
  delete args.state.closeAfterMs;
  return lease;
}

export function releaseNativeLocalTuiWarmLease(args: {
  state: NativeLocalTuiWarmState;
  request: NativeTuiSurfaceReleaseRequest;
  nowMs: number;
  idleCloseMs?: number;
}): void {
  const surfaceId = nativeLocalTuiSurfaceKey(args.request);
  args.state.leases.delete(surfaceId);
  if (args.state.leases.size > 0) {
    return;
  }
  const idleCloseMs = Math.max(
    1,
    Math.floor(args.idleCloseMs ?? DEFAULT_NATIVE_LOCAL_TUI_IDLE_CLOSE_MS),
  );
  args.state.idleSinceMs = args.nowMs;
  args.state.closeAfterMs = args.nowMs + idleCloseMs;
}

export function nativeLocalTuiWarmStateIdleExpired(
  state: NativeLocalTuiWarmState | undefined,
  nowMs: number,
): boolean {
  return Boolean(
    state &&
      state.leases.size === 0 &&
      state.closeAfterMs !== undefined &&
      nowMs >= state.closeAfterMs,
  );
}
