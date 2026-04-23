import type { IncomingMessage, ServerResponse } from "node:http";

export function normalizeOriginHostname(hostname: string): string {
  const normalized = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return "loopback";
  }
  return normalized;
}

export function requestProtocol(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return "http";
}

export function isAllowedOrigin(req: IncomingMessage): boolean {
  const originHeader = req.headers.origin;
  if (typeof originHeader !== "string" || !originHeader.trim()) {
    return true;
  }
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || !hostHeader.trim()) {
    return false;
  }
  try {
    const origin = new URL(originHeader);
    const requestUrl = new URL(`${requestProtocol(req)}://` + hostHeader);
    const sameHost =
      normalizeOriginHostname(origin.hostname) === normalizeOriginHostname(requestUrl.hostname);
    const originPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
    const requestPort = requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80");
    return sameHost && originPort === requestPort;
  } catch {
    return false;
  }
}

export function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const originHeader = req.headers.origin;
  res.setHeader("vary", "Origin");
  if (typeof originHeader === "string" && originHeader.trim() && isAllowedOrigin(req)) {
    res.setHeader("access-control-allow-origin", originHeader);
  }
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-rah-client");
}

export function validateApiRequest(req: IncomingMessage, pathname: string): string | null {
  if (!pathname.startsWith("/api/")) {
    return null;
  }
  if (!isAllowedOrigin(req)) {
    return "Cross-origin requests are not allowed.";
  }
  if (
    req.method === "POST" &&
    typeof req.headers.origin === "string" &&
    req.headers["x-rah-client"] !== "web"
  ) {
    return "Missing required RAH client header.";
  }
  return null;
}
