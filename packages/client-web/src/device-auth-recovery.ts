export type DeviceAuthViewState = "loading" | "trusted" | "reconnecting" | "pairing";

export type DeviceAuthTrustStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const DEVICE_AUTH_TRUST_HINT_KEY = "rah.device-auth.trusted.v1";

const AUTH_RETRY_DELAYS_MS = [750, 1_500, 3_000, 5_000] as const;

export function deviceAuthStateForStatus(authenticated: boolean): DeviceAuthViewState {
  return authenticated ? "trusted" : "pairing";
}

export function deviceAuthStateForFailure(hasReachedTrusted: boolean): DeviceAuthViewState {
  return hasReachedTrusted ? "trusted" : "reconnecting";
}

export function deviceAuthRetryDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), AUTH_RETRY_DELAYS_MS.length - 1));
  return AUTH_RETRY_DELAYS_MS[index]!;
}

export function readDeviceAuthTrustHint(
  storage: DeviceAuthTrustStorage | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(DEVICE_AUTH_TRUST_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDeviceAuthTrustHint(
  storage: DeviceAuthTrustStorage | null | undefined,
  trusted: boolean,
): void {
  if (!storage) return;
  try {
    if (trusted) {
      storage.setItem(DEVICE_AUTH_TRUST_HINT_KEY, "1");
    } else {
      storage.removeItem(DEVICE_AUTH_TRUST_HINT_KEY);
    }
  } catch {
    // Storage can be disabled independently of the device-auth cookie.
  }
}
