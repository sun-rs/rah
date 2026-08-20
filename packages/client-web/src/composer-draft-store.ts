import { useSyncExternalStore, type Dispatch, type SetStateAction } from "react";

const drafts = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) {
    listener();
  }
}

export function readComposerDraft(key: string | null): string {
  return key ? drafts.get(key) ?? "" : "";
}

export function subscribeComposerDraft(
  key: string | null,
  listener: () => void,
): () => void {
  if (!key) {
    return () => undefined;
  }
  const scopedListeners = listeners.get(key) ?? new Set<() => void>();
  scopedListeners.add(listener);
  listeners.set(key, scopedListeners);
  return () => {
    scopedListeners.delete(listener);
    if (scopedListeners.size === 0) {
      listeners.delete(key);
    }
  };
}

export function updateSharedComposerDraft(
  key: string | null,
  nextDraft: SetStateAction<string>,
): void {
  if (!key) {
    return;
  }
  const current = drafts.get(key) ?? "";
  const next = typeof nextDraft === "function" ? nextDraft(current) : nextDraft;
  if (next === current) {
    return;
  }
  if (next) {
    drafts.set(key, next);
  } else {
    drafts.delete(key);
  }
  emit(key);
}

export function useSharedComposerDraft(
  key: string | null,
): [string, Dispatch<SetStateAction<string>>] {
  const draft = useSyncExternalStore(
    (listener) => subscribeComposerDraft(key, listener),
    () => readComposerDraft(key),
    () => readComposerDraft(key),
  );
  return [draft, (nextDraft) => updateSharedComposerDraft(key, nextDraft)];
}

export function resetComposerDraftStoreForTests(): void {
  const keys = [...drafts.keys()];
  drafts.clear();
  for (const key of keys) {
    emit(key);
  }
}
