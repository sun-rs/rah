import { useCallback, useRef, useState } from "react";
import type { SessionInputAnnotation } from "@rah/runtime-protocol";
import {
  appendComposerAnnotation,
  MAX_COMPOSER_ANNOTATIONS,
} from "../composer-annotations";

export function useComposerAnnotations(scopeKey = "default") {
  const [, setRevision] = useState(0);
  const itemsByScopeRef = useRef(new Map<string, SessionInputAnnotation[]>());
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  const items = itemsByScopeRef.current.get(scopeKey) ?? [];

  const add = useCallback((annotation: SessionInputAnnotation) => {
    const current = itemsByScopeRef.current.get(scopeKey) ?? [];
    itemsByScopeRef.current.set(
      scopeKey,
      appendComposerAnnotation(current, annotation),
    );
    refresh();
  }, [refresh, scopeKey]);

  const remove = useCallback((id: string) => {
    const current = itemsByScopeRef.current.get(scopeKey) ?? [];
    itemsByScopeRef.current.set(
      scopeKey,
      current.filter((item) => item.id !== id),
    );
    refresh();
  }, [refresh, scopeKey]);

  const clear = useCallback(() => {
    itemsByScopeRef.current.set(scopeKey, []);
    refresh();
  }, [refresh, scopeKey]);

  const take = useCallback((): SessionInputAnnotation[] => {
    const current = itemsByScopeRef.current.get(scopeKey) ?? [];
    itemsByScopeRef.current.set(scopeKey, []);
    refresh();
    return current;
  }, [refresh, scopeKey]);

  const restore = useCallback((restored: readonly SessionInputAnnotation[]) => {
    if (restored.length === 0) {
      return;
    }
    const current = itemsByScopeRef.current.get(scopeKey) ?? [];
    itemsByScopeRef.current.set(
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
