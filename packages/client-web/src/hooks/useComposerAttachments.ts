import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInputAttachment } from "@rah/runtime-protocol";
import * as api from "../api";

export interface ComposerAttachmentItem {
  attachment: SessionInputAttachment;
  previewUrl?: string;
}

const MAX_COMPOSER_ATTACHMENTS = 10;

function releasePreview(item: ComposerAttachmentItem): void {
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function previewUrlForFile(file: File): string | undefined {
  return file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
}

export function useComposerAttachments(scopeKey = "default") {
  const [, setRevision] = useState(0);
  const itemsByScopeRef = useRef(new Map<string, ComposerAttachmentItem[]>());
  const pendingByScopeRef = useRef(new Map<string, number>());
  const errorByScopeRef = useRef(new Map<string, string | null>());
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  const items = itemsByScopeRef.current.get(scopeKey) ?? [];
  const pendingCount = pendingByScopeRef.current.get(scopeKey) ?? 0;
  const error = errorByScopeRef.current.get(scopeKey) ?? null;

  useEffect(() => {
    return () => {
      for (const scopedItems of itemsByScopeRef.current.values()) {
        for (const item of scopedItems) releasePreview(item);
      }
    };
  }, []);

  const uploadFiles = useCallback(async (files: readonly File[]) => {
    const currentItems = itemsByScopeRef.current.get(scopeKey) ?? [];
    const currentPending = pendingByScopeRef.current.get(scopeKey) ?? 0;
    const available = Math.max(
      0,
      MAX_COMPOSER_ATTACHMENTS - currentItems.length - currentPending,
    );
    const selected = files.slice(0, available);
    if (selected.length === 0) {
      errorByScopeRef.current.set(
        scopeKey,
        available === 0
          ? `A message can include up to ${MAX_COMPOSER_ATTACHMENTS} attachments.`
          : null,
      );
      refresh();
      return;
    }
    errorByScopeRef.current.set(
      scopeKey,
      selected.length < files.length
        ? `Only the first ${available} attachments were added.`
        : null,
    );
    pendingByScopeRef.current.set(scopeKey, currentPending + selected.length);
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
      itemsByScopeRef.current.set(scopeKey, [
        ...(itemsByScopeRef.current.get(scopeKey) ?? []),
        ...uploaded,
      ]);
    }
    if (failureMessage) {
      errorByScopeRef.current.set(scopeKey, failureMessage);
    }
    pendingByScopeRef.current.set(
      scopeKey,
      Math.max(0, (pendingByScopeRef.current.get(scopeKey) ?? 0) - selected.length),
    );
    refresh();
  }, [refresh, scopeKey]);

  const remove = useCallback((index: number) => {
    const current = itemsByScopeRef.current.get(scopeKey) ?? [];
    const item = current[index];
    if (item) releasePreview(item);
    itemsByScopeRef.current.set(
      scopeKey,
      current.filter((_, candidateIndex) => candidateIndex !== index),
    );
    refresh();
  }, [refresh, scopeKey]);

  const removeLast = useCallback(() => {
    const current = itemsByScopeRef.current.get(scopeKey) ?? [];
    const item = current.at(-1);
    if (item) releasePreview(item);
    itemsByScopeRef.current.set(scopeKey, current.slice(0, -1));
    refresh();
  }, [refresh, scopeKey]);

  const clear = useCallback(() => {
    for (const item of itemsByScopeRef.current.get(scopeKey) ?? []) releasePreview(item);
    itemsByScopeRef.current.set(scopeKey, []);
    errorByScopeRef.current.set(scopeKey, null);
    refresh();
  }, [refresh, scopeKey]);

  const take = useCallback((): ComposerAttachmentItem[] => {
    const current = itemsByScopeRef.current.get(scopeKey) ?? [];
    itemsByScopeRef.current.set(scopeKey, []);
    errorByScopeRef.current.set(scopeKey, null);
    refresh();
    return current;
  }, [refresh, scopeKey]);

  const restore = useCallback((restored: readonly ComposerAttachmentItem[]) => {
    if (restored.length === 0) {
      return;
    }
    itemsByScopeRef.current.set(scopeKey, [
      ...restored,
      ...(itemsByScopeRef.current.get(scopeKey) ?? []),
    ]);
    refresh();
  }, [refresh, scopeKey]);

  const release = useCallback((released: readonly ComposerAttachmentItem[]) => {
    for (const item of released) {
      releasePreview(item);
    }
  }, []);

  const setError = useCallback((nextError: string | null) => {
    errorByScopeRef.current.set(scopeKey, nextError);
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
