import { useCallback, useSyncExternalStore } from "react";
import type { SessionInputAttachment } from "@rah/runtime-protocol";
import * as api from "../api";

export interface ComposerAttachmentItem {
  attachment: SessionInputAttachment;
  previewUrl?: string;
}

const MAX_COMPOSER_ATTACHMENTS = 10;
const itemsByScope = new Map<string, ComposerAttachmentItem[]>();
const pendingByScope = new Map<string, number>();
const errorByScope = new Map<string, string | null>();
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

function releasePreview(item: ComposerAttachmentItem): void {
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function previewUrlForFile(file: File): string | undefined {
  return file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
}

export function useComposerAttachments(scopeKey = "default") {
  useSyncExternalStore(
    (listener) => subscribeScope(scopeKey, listener),
    () => revisionByScope.get(scopeKey) ?? 0,
    () => revisionByScope.get(scopeKey) ?? 0,
  );
  const items = itemsByScope.get(scopeKey) ?? [];
  const pendingCount = pendingByScope.get(scopeKey) ?? 0;
  const error = errorByScope.get(scopeKey) ?? null;
  const refresh = useCallback(() => refreshScope(scopeKey), [scopeKey]);

  const uploadFiles = useCallback(async (files: readonly File[]) => {
    const currentItems = itemsByScope.get(scopeKey) ?? [];
    const currentPending = pendingByScope.get(scopeKey) ?? 0;
    const available = Math.max(
      0,
      MAX_COMPOSER_ATTACHMENTS - currentItems.length - currentPending,
    );
    const selected = files.slice(0, available);
    if (selected.length === 0) {
      errorByScope.set(
        scopeKey,
        available === 0
          ? `A message can include up to ${MAX_COMPOSER_ATTACHMENTS} attachments.`
          : null,
      );
      refresh();
      return;
    }
    errorByScope.set(
      scopeKey,
      selected.length < files.length
        ? `Only the first ${available} attachments were added.`
        : null,
    );
    pendingByScope.set(scopeKey, currentPending + selected.length);
    refresh();
    const results = await Promise.allSettled(
      selected.map(async (file): Promise<ComposerAttachmentItem> => {
        const attachment = await api.uploadAttachment(file);
        const previewUrl = previewUrlForFile(file);
        return {
          attachment,
          ...(previewUrl ? { previewUrl } : {}),
        };
      }),
    );
    const uploaded: ComposerAttachmentItem[] = [];
    let failureMessage: string | null = null;
    for (const result of results) {
      if (result.status === "fulfilled") {
        uploaded.push(result.value);
      } else if (!failureMessage) {
        failureMessage =
          result.reason instanceof Error ? result.reason.message : "Attachment upload failed.";
      }
    }
    if (uploaded.length > 0) {
      itemsByScope.set(scopeKey, [
        ...(itemsByScope.get(scopeKey) ?? []),
        ...uploaded,
      ]);
    }
    if (failureMessage) {
      errorByScope.set(scopeKey, failureMessage);
    }
    pendingByScope.set(
      scopeKey,
      Math.max(0, (pendingByScope.get(scopeKey) ?? 0) - selected.length),
    );
    refresh();
  }, [refresh, scopeKey]);

  const remove = useCallback((index: number) => {
    const current = itemsByScope.get(scopeKey) ?? [];
    const item = current[index];
    if (item) releasePreview(item);
    itemsByScope.set(
      scopeKey,
      current.filter((_, candidateIndex) => candidateIndex !== index),
    );
    refresh();
  }, [refresh, scopeKey]);

  const removeLast = useCallback(() => {
    const current = itemsByScope.get(scopeKey) ?? [];
    const item = current.at(-1);
    if (item) releasePreview(item);
    itemsByScope.set(scopeKey, current.slice(0, -1));
    refresh();
  }, [refresh, scopeKey]);

  const clear = useCallback(() => {
    for (const item of itemsByScope.get(scopeKey) ?? []) releasePreview(item);
    itemsByScope.set(scopeKey, []);
    errorByScope.set(scopeKey, null);
    refresh();
  }, [refresh, scopeKey]);

  const take = useCallback((): ComposerAttachmentItem[] => {
    const current = itemsByScope.get(scopeKey) ?? [];
    itemsByScope.set(scopeKey, []);
    errorByScope.set(scopeKey, null);
    refresh();
    return current;
  }, [refresh, scopeKey]);

  const restore = useCallback((restored: readonly ComposerAttachmentItem[]) => {
    if (restored.length === 0) {
      return;
    }
    itemsByScope.set(scopeKey, [
      ...restored,
      ...(itemsByScope.get(scopeKey) ?? []),
    ]);
    refresh();
  }, [refresh, scopeKey]);

  const release = useCallback((released: readonly ComposerAttachmentItem[]) => {
    for (const item of released) {
      releasePreview(item);
    }
  }, []);

  const setError = useCallback((nextError: string | null) => {
    errorByScope.set(scopeKey, nextError);
    refresh();
  }, [refresh, scopeKey]);

  return {
    items,
    attachments: items.map((item) => item.attachment),
    count: items.length,
    pendingCount,
    uploading: pendingCount > 0,
    error,
    setError,
    uploadFiles,
    remove,
    removeLast,
    clear,
    take,
    restore,
    release,
  };
}
