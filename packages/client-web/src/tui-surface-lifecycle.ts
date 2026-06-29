export const COUNCIL_TUI_WARM_LIMIT = 8;
export const COUNCIL_TUI_WARM_TTL_MS = 5 * 60 * 1000;
export const PROVIDER_TUI_REPLAY_TAIL_BYTES = 96 * 1024;
export const TERMINAL_LAYOUT_SETTLE_DELAYS_MS = [80, 160, 320, 640, 1_200] as const;

export type ActiveSessionTuiSurface = {
  terminalId: string;
  clientId: string;
} | null;

export function resolveActiveSessionTuiSurface(args: {
  terminalId?: string | null;
  clientId: string;
  openedTerminalIds: ReadonlySet<string>;
  closedTerminalIds: ReadonlySet<string>;
}): ActiveSessionTuiSurface {
  const terminalId = args.terminalId;
  if (!terminalId) {
    return null;
  }
  if (!args.openedTerminalIds.has(terminalId) || args.closedTerminalIds.has(terminalId)) {
    return null;
  }
  return { terminalId, clientId: args.clientId };
}

export function activateSessionTuiTerminal(args: {
  terminalId: string;
  openedTerminalIds: ReadonlySet<string>;
  closedTerminalIds: ReadonlySet<string>;
}): {
  openedTerminalIds: Set<string>;
  closedTerminalIds: Set<string>;
} {
  const openedTerminalIds = new Set(args.openedTerminalIds);
  const closedTerminalIds = new Set(args.closedTerminalIds);
  openedTerminalIds.add(args.terminalId);
  closedTerminalIds.delete(args.terminalId);
  return { openedTerminalIds, closedTerminalIds };
}

export function shouldReplayInitialSessionTuiOutput(args: {
  liveBackend?: string | null | undefined;
}): boolean {
  void args;
  return true;
}

export type CouncilTuiCacheState = {
  visitedAgentIds: Set<string>;
  touchedAtByAgentId: Map<string, number>;
  detachedAgentIds: Set<string>;
};

export function touchCouncilTuiCache(args: {
  state: CouncilTuiCacheState;
  agentId: string;
  liveAgentIds: Iterable<string>;
  now: number;
  attach?: boolean;
  activeAgentId?: string | null;
  warmLimit?: number;
  warmTtlMs?: number;
}): CouncilTuiCacheState {
  const visitedAgentIds = new Set(args.state.visitedAgentIds);
  const touchedAtByAgentId = new Map(args.state.touchedAtByAgentId);
  const detachedAgentIds = new Set(args.state.detachedAgentIds);
  visitedAgentIds.add(args.agentId);
  touchedAtByAgentId.set(args.agentId, args.now);
  if (args.attach) {
    detachedAgentIds.delete(args.agentId);
  }

  return pruneCouncilTuiCache({
    state: { visitedAgentIds, touchedAtByAgentId, detachedAgentIds },
    liveAgentIds: args.liveAgentIds,
    now: args.now,
    activeAgentId: args.activeAgentId ?? args.agentId,
    ...(args.warmLimit !== undefined ? { warmLimit: args.warmLimit } : {}),
    ...(args.warmTtlMs !== undefined ? { warmTtlMs: args.warmTtlMs } : {}),
  });
}

export function warmCouncilTuiCache(args: {
  state: CouncilTuiCacheState;
  agentIds: Iterable<string>;
  liveAgentIds: Iterable<string>;
  now: number;
  attach?: boolean;
  activeAgentId?: string | null;
  warmLimit?: number;
  warmTtlMs?: number;
}): CouncilTuiCacheState {
  const visitedAgentIds = new Set(args.state.visitedAgentIds);
  const touchedAtByAgentId = new Map(args.state.touchedAtByAgentId);
  const detachedAgentIds = new Set(args.state.detachedAgentIds);
  for (const agentId of args.agentIds) {
    visitedAgentIds.add(agentId);
    touchedAtByAgentId.set(agentId, args.now);
    if (args.attach) {
      detachedAgentIds.delete(agentId);
    }
  }
  return pruneCouncilTuiCache({
    state: { visitedAgentIds, touchedAtByAgentId, detachedAgentIds },
    liveAgentIds: args.liveAgentIds,
    now: args.now,
    ...(args.activeAgentId !== undefined ? { activeAgentId: args.activeAgentId } : {}),
    ...(args.warmLimit !== undefined ? { warmLimit: args.warmLimit } : {}),
    ...(args.warmTtlMs !== undefined ? { warmTtlMs: args.warmTtlMs } : {}),
  });
}

export function setCouncilTuiDetached(args: {
  state: CouncilTuiCacheState;
  agentId: string;
  detached: boolean;
  now: number;
}): CouncilTuiCacheState {
  const visitedAgentIds = new Set(args.state.visitedAgentIds);
  const touchedAtByAgentId = new Map(args.state.touchedAtByAgentId);
  const detachedAgentIds = new Set(args.state.detachedAgentIds);
  visitedAgentIds.add(args.agentId);
  touchedAtByAgentId.set(args.agentId, args.now);
  if (args.detached) {
    detachedAgentIds.add(args.agentId);
  } else {
    detachedAgentIds.delete(args.agentId);
  }
  return { visitedAgentIds, touchedAtByAgentId, detachedAgentIds };
}

export function removeCouncilTuiAgent(
  state: CouncilTuiCacheState,
  agentId: string,
): CouncilTuiCacheState {
  const visitedAgentIds = new Set(state.visitedAgentIds);
  const touchedAtByAgentId = new Map(state.touchedAtByAgentId);
  const detachedAgentIds = new Set(state.detachedAgentIds);
  visitedAgentIds.delete(agentId);
  touchedAtByAgentId.delete(agentId);
  detachedAgentIds.delete(agentId);
  return { visitedAgentIds, touchedAtByAgentId, detachedAgentIds };
}

export function resetCouncilTuiCache(): CouncilTuiCacheState {
  return {
    visitedAgentIds: new Set(),
    touchedAtByAgentId: new Map(),
    detachedAgentIds: new Set(),
  };
}

export function pruneCouncilTuiCache(args: {
  state: CouncilTuiCacheState;
  liveAgentIds: Iterable<string>;
  now: number;
  activeAgentId?: string | null;
  warmLimit?: number;
  warmTtlMs?: number;
}): CouncilTuiCacheState {
  const liveAgentIdSet = new Set(args.liveAgentIds);
  const activeAgentId = args.activeAgentId ?? null;
  const warmLimit = args.warmLimit ?? COUNCIL_TUI_WARM_LIMIT;
  const warmTtlMs = args.warmTtlMs ?? COUNCIL_TUI_WARM_TTL_MS;
  const visitedAgentIds = new Set<string>();
  const touchedAtByAgentId = new Map<string, number>();
  const detachedAgentIds = new Set<string>();

  for (const agentId of args.state.visitedAgentIds) {
    if (!liveAgentIdSet.has(agentId)) {
      continue;
    }
    const touchedAt = args.state.touchedAtByAgentId.get(agentId) ?? 0;
    const expired = args.now - touchedAt > warmTtlMs;
    if (expired && agentId !== activeAgentId) {
      continue;
    }
    visitedAgentIds.add(agentId);
    touchedAtByAgentId.set(agentId, touchedAt);
    if (args.state.detachedAgentIds.has(agentId)) {
      detachedAgentIds.add(agentId);
    }
  }

  while (visitedAgentIds.size > warmLimit) {
    const removable = [...visitedAgentIds]
      .filter((agentId) => agentId !== activeAgentId)
      .sort((a, b) => (touchedAtByAgentId.get(a) ?? 0) - (touchedAtByAgentId.get(b) ?? 0));
    const nextRemoved = removable[0];
    if (!nextRemoved) {
      break;
    }
    visitedAgentIds.delete(nextRemoved);
    touchedAtByAgentId.delete(nextRemoved);
    detachedAgentIds.delete(nextRemoved);
  }

  return { visitedAgentIds, touchedAtByAgentId, detachedAgentIds };
}
