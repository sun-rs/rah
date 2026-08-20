import type { RuntimeIdentityResponse } from "@rah/runtime-protocol";
import type { ErrorRecoveryDescriptor } from "./error-recovery";

export const RUNTIME_COMPATIBILITY_MUTED_DATE_KEY =
  "rah.runtime-compatibility-muted-date.v1";
export const RUNTIME_COMPATIBILITY_MUTED_DATE_COOKIE =
  "rah_runtime_compatibility_muted_date_v1";

type RuntimeCompatibilityStorage = Pick<Storage, "getItem" | "setItem">;

export interface RuntimeCompatibilityMutePersistence {
  storages?: readonly (RuntimeCompatibilityStorage | undefined)[];
  cookieHeader?: string;
  writeCookie?: (cookie: string) => void;
}

let volatileMutedDate: string | null = null;

export function runtimeCompatibilityLocalDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isRuntimeCompatibilityMutedToday(
  persistence: RuntimeCompatibilityMutePersistence | undefined,
  now = new Date(),
): boolean {
  const mutedDate = runtimeCompatibilityLocalDate(now);
  if (volatileMutedDate === mutedDate) {
    return true;
  }

  for (const storage of persistence?.storages ?? []) {
    if (!storage) {
      continue;
    }
    try {
      if (storage.getItem(RUNTIME_COMPATIBILITY_MUTED_DATE_KEY) === mutedDate) {
        volatileMutedDate = mutedDate;
        return true;
      }
    } catch {
      // iOS standalone/private browsing can reject one storage surface while
      // another remains available. Keep checking the remaining fallbacks.
    }
  }

  const cookieDate = runtimeCompatibilityMuteDateFromCookie(
    persistence?.cookieHeader,
  );
  if (cookieDate === mutedDate) {
    volatileMutedDate = mutedDate;
    return true;
  }
  return false;
}

export function muteRuntimeCompatibilityForToday(
  persistence: RuntimeCompatibilityMutePersistence | undefined,
  now = new Date(),
): void {
  const mutedDate = runtimeCompatibilityLocalDate(now);
  volatileMutedDate = mutedDate;

  for (const storage of persistence?.storages ?? []) {
    if (!storage) {
      continue;
    }
    try {
      storage.setItem(RUNTIME_COMPATIBILITY_MUTED_DATE_KEY, mutedDate);
    } catch {
      // Private browsing or a full quota must not prevent the in-memory and
      // cookie/session fallbacks from dismissing the notice.
    }
  }

  if (persistence?.writeCookie) {
    try {
      persistence.writeCookie(runtimeCompatibilityMuteCookie(now));
    } catch {
      // A cookie-blocking policy still leaves the volatile/storage fallbacks.
    }
  }
}

export function runtimeCompatibilityMuteDateFromCookie(
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name !== RUNTIME_COMPATIBILITY_MUTED_DATE_COOKIE) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function runtimeCompatibilityMuteCookie(now = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  const maxAgeSeconds = Math.max(
    1,
    Math.ceil((tomorrow.getTime() - now.getTime()) / 1_000),
  );
  return `${RUNTIME_COMPATIBILITY_MUTED_DATE_COOKIE}=${encodeURIComponent(
    runtimeCompatibilityLocalDate(now),
  )}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

export function browserRuntimeCompatibilityMutePersistence(): RuntimeCompatibilityMutePersistence {
  const storages: Array<RuntimeCompatibilityStorage | undefined> = [];
  if (typeof window !== "undefined") {
    try {
      storages.push(window.localStorage);
    } catch {
      storages.push(undefined);
    }
    try {
      storages.push(window.sessionStorage);
    } catch {
      storages.push(undefined);
    }
  }

  let cookieHeader: string | undefined;
  let writeCookie: ((cookie: string) => void) | undefined;
  if (typeof document !== "undefined") {
    try {
      cookieHeader = document.cookie;
      writeCookie = (cookie) => {
        document.cookie = cookie;
      };
    } catch {
      // Cookie access can also be disabled independently of Web Storage.
    }
  }

  return {
    storages,
    ...(cookieHeader !== undefined ? { cookieHeader } : {}),
    ...(writeCookie ? { writeCookie } : {}),
  };
}

export function resetVolatileRuntimeCompatibilityMuteForTests(): void {
  volatileMutedDate = null;
}

export function deriveRuntimeCompatibilityDescriptor(
  webBuildId: string,
  runtimeIdentity: Pick<RuntimeIdentityResponse, "pid" | "webBuildId">,
): ErrorRecoveryDescriptor | null {
  const browserGeneration = webBuildId.trim();
  const daemonGeneration = runtimeIdentity.webBuildId?.trim() ?? "";
  if (!browserGeneration || browserGeneration === daemonGeneration) {
    return null;
  }
  return {
    title: "Restart RAH to update",
    body: "Restart it on the host, then refresh this page.",
  };
}
