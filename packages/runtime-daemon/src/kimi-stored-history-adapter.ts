import path from "node:path";
import type {
  SessionHistoryPageResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import type {
  ProviderAdapter,
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import {
  createKimiStoredSessionFrozenHistoryPageLoader,
  discoverKimiStoredSessions,
  getKimiStoredSessionHistoryPage,
  resolveKimiStoredSessionWatchRoots,
  type KimiStoredSessionRecord,
} from "./kimi-session-files";
import { movePathToTrash } from "./trash";

export class KimiStoredHistoryAdapter implements ProviderAdapter, ProviderStoredHistoryAdapter {
  readonly id = "kimi-stored-history";
  readonly providers: Array<"kimi"> = ["kimi"];

  private storedSessionIndex = new Map<string, KimiStoredSessionRecord>();

  constructor(private readonly services: RuntimeServices) {}

  getSessionHistoryPage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      return { sessionId, events: [] };
    }
    const record =
      this.refreshStoredSessionIndex().get(state.session.providerSessionId) ??
      this.storedSessionIndex.get(state.session.providerSessionId);
    if (!record) {
      return { sessionId, events: [] };
    }
    return getKimiStoredSessionHistoryPage({
      sessionId,
      record,
      ...(options?.beforeTs ? { beforeTs: options.beforeTs } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    });
  }

  createFrozenHistoryPageLoader(sessionId: string) {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      return undefined;
    }
    const record =
      this.refreshStoredSessionIndex().get(state.session.providerSessionId) ??
      this.storedSessionIndex.get(state.session.providerSessionId);
    if (!record) {
      return undefined;
    }
    return createKimiStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
    });
  }

  listStoredSessions(): StoredSessionRef[] {
    if (this.storedSessionIndex.size === 0) {
      this.refreshStoredSessionIndex();
    }
    return [...this.storedSessionIndex.values()].map((record) => record.ref);
  }

  refreshStoredSessionsCatalog(): StoredSessionRef[] {
    this.refreshStoredSessionIndex();
    return this.listStoredSessions();
  }

  listStoredSessionWatchRoots(): string[] {
    return resolveKimiStoredSessionWatchRoots();
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Kimi history directory for ${session.providerSessionId}.`);
    }
    await movePathToTrash(path.dirname(record.wirePath));
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  private refreshStoredSessionIndex(): Map<string, KimiStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverKimiStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}
