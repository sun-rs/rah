import { networkInterfaces } from "node:os";

function normalizeRemoteAddress(remoteAddress: string | undefined): string | null {
  if (!remoteAddress) {
    return null;
  }
  if (remoteAddress.startsWith("::ffff:")) {
    return remoteAddress.slice("::ffff:".length);
  }
  return remoteAddress;
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(remoteAddress);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function isLocalMachineRemoteAddress(remoteAddress: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(remoteAddress);
  if (!normalized) {
    return false;
  }
  if (isLoopbackRemoteAddress(normalized)) {
    return true;
  }
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address === normalized) {
        return true;
      }
    }
  }
  return false;
}
