import type {
  ManagedSession,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";

type ProviderSessionIdentity = Pick<StoredSessionRef, "provider" | "providerSessionId">;

type CanonicalTitleContext = {
  titleOverrides?: Readonly<Record<string, string>>;
  discoveredStoredSessions?: readonly StoredSessionRef[];
};

function cleanLabel(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function providerSessionKey(session: ProviderSessionIdentity): string {
  return `${session.provider}:${session.providerSessionId}`;
}

export function resolveCanonicalSessionTitle(
  session: Pick<ManagedSession, "provider" | "providerSessionId" | "title">,
  context: CanonicalTitleContext = {},
): string | undefined {
  const providerSessionId = session.providerSessionId;
  if (!providerSessionId) {
    return cleanLabel(session.title);
  }

  const key = providerSessionKey({
    provider: session.provider,
    providerSessionId,
  });
  const override = cleanLabel(context.titleOverrides?.[key]);
  if (override) {
    return override;
  }

  const discovered = context.discoveredStoredSessions?.find(
    (entry) =>
      entry.provider === session.provider &&
      entry.providerSessionId === providerSessionId,
  );
  const discoveredTitle = cleanLabel(discovered?.title);
  if (discoveredTitle) {
    return discoveredTitle;
  }

  return cleanLabel(session.title);
}

export function applyCanonicalTitleToStoredSession(
  session: StoredSessionRef,
  context: CanonicalTitleContext = {},
): StoredSessionRef {
  const title = resolveCanonicalSessionTitle(session, context);
  if (!title || title === session.title) {
    return session;
  }
  return {
    ...session,
    title,
  };
}

export function applyCanonicalTitleToSessionSummary(
  summary: SessionSummary,
  context: CanonicalTitleContext = {},
): SessionSummary {
  const title = resolveCanonicalSessionTitle(summary.session, context);
  if (!title || title === summary.session.title) {
    return summary;
  }
  return {
    ...summary,
    session: {
      ...summary.session,
      title,
    },
  };
}

export function resolveSessionTitleAndPreview(args: {
  canonicalTitle?: string | null;
  providerTitle?: string | null;
  fallbackTitle?: string | null;
  providerPreview?: string | null;
  fallbackPreview?: string | null;
}): { title?: string; preview?: string } {
  const title =
    cleanLabel(args.canonicalTitle) ??
    cleanLabel(args.providerTitle) ??
    cleanLabel(args.fallbackTitle);
  const preview =
    cleanLabel(args.providerPreview) ??
    cleanLabel(args.fallbackPreview);
  return {
    ...(title ? { title } : {}),
    ...(preview ? { preview } : {}),
  };
}
