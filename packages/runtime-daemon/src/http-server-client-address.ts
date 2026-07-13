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

export function isLocalNetworkRemoteAddress(remoteAddress: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(remoteAddress);
  if (!normalized) {
    return false;
  }
  if (isLocalMachineRemoteAddress(normalized)) {
    return true;
  }
  const ipv4 = normalized.split(".").map((part) => Number.parseInt(part, 10));
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [a, b] = ipv4 as [number, number, number, number];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return normalized.toLowerCase().startsWith("fe80:");
}

export function resolveImagePreviewModeForPeer(args: {
  hostname: string;
  remoteAddress: string | undefined;
  clientHint?: string | null;
}): "bounded" | "full" {
  if (args.clientHint === "remote") {
    return "bounded";
  }
  return isLocalPreviewHostname(args.hostname) &&
    isLocalNetworkRemoteAddress(args.remoteAddress)
    ? "full"
    : "bounded";
}

function isLocalPreviewHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local") ||
    hostname.startsWith("127.")
  ) {
    return true;
  }
  const ipv4 = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (
    ipv4.length !== 4 ||
    ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = ipv4 as [number, number, number, number];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
