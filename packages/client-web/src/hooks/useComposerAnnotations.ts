import { useCallback, useSyncExternalStore } from "react";
import type { SessionInputAnnotation } from "@rah/runtime-protocol";
import {
  appendComposerAnnotation,
  MAX_COMPOSER_ANNOTATIONS,
} from "../composer-annotations";

const itemsByScope = new Map<string, SessionInputAnnotation[]>();
const revisionByScope = new Map<string, number>();
const listenersByScope = new Map<string, Set<() => void>>();

function refreshScope(scopeKey: string): void {
  revisionByScope.set(scopeKey, (revisionByScope.get(scopeKey) ?? 0) + 1);
  for (const listener of listenersByScope.get(scopeKey) ?? []) listener();
}

function subscribeScope(scopeKey: string, listener: () => void): () => void {
  const listeners = listenersByScope.get(scopeKey) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByScope.set(scopeKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByScope.delete(scopeKey);
  };
}

export function useComposerAnnotations(scopeKey = "default") {
  useSyncExternalStore(
    (listener) => subscribeScope(scopeKey, listener),
    () => revisionByScope.get(scopeKey) ?? 0,
    () => revisionByScope.get(scopeKey) ?? 0,
  );
  const refresh = useCallback(() => refreshScope(scopeKey), [scopeKey]);
  const items = itemsByScope.get(scopeKey) ?? [];

  const add = useCallback((annotation: SessionInputAnnotation) => {
    const current = itemsByScope.get(scopeKey) ?? [];
    itemsByScope.set(
      scopeKey,
      appendComposerAnnotation(current, annotation),
    );
    refresh();
  }, [refresh, scopeKey]);

  const remove = useCallback((id: string) => {
    const current = itemsByScope.get(scopeKey) ?? [];
    itemsByScope.set(
      scopeKey,
      current.filter((item) => item.id !== id),
    );
    refresh();
  }, [refresh, scopeKey]);

  const clear = useCallback(() => {
    itemsByScope.set(scopeKey, []);
    refresh();
  }, [refresh, scopeKey]);

  const take = useCallback((): SessionInputAnnotation[] => {
    const current = itemsByScope.get(scopeKey) ?? [];
    itemsByScope.set(scopeKey, []);
    refresh();
    return current;
  }, [refresh, scopeKey]);

  const restore = useCallback((restored: readonly SessionInputAnnotation[]) => {
    if (restored.length === 0) {
      return;
    }
    const current = itemsByScope.get(scopeKey) ?? [];
    itemsByScope.set(
      scopeKey,
      [...restored, ...current].slice(-MAX_COMPOSER_ANNOTATIONS),
    );
    refresh();
  }, [refresh, scopeKey]);

  return {
    items,
    count: items.length,
    add,
    remove,
    clear,
    take,
    restore,
  };
}
