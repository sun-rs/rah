import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type {
  DeviceAuthStatusResponse,
  ListTrustedDevicesResponse,
  PairDeviceRequest,
  PairDeviceResponse,
  PairingCodeResponse,
  PairingCodeStatusResponse,
  RevokeTrustedDeviceResponse,
  TrustedDeviceDescriptor,
} from "@rah/runtime-protocol";
import { requestProtocol } from "./http-server-cors";
import { readJsonBody, writeJson } from "./http-server-response";
import {
  isLocalMachineRemoteAddress,
  isLoopbackRemoteAddress,
} from "./http-server-client-address";

const DEVICE_COOKIE_NAME = "rah_device";
const DEVICE_TOKEN_BYTES = 32;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1_000;
const PAIRING_ATTEMPT_WINDOW_MS = 10 * 60 * 1_000;
const MAX_PAIRING_ATTEMPTS_PER_WINDOW = 8;
const DEFAULT_MAX_PAIRING_ATTEMPT_KEYS = 1_024;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_DEVICE_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 256;

type StoredTrustedDevice = TrustedDeviceDescriptor & {
  tokenHash: string;
  userAgent?: string;
};

type StoredDeviceRegistry = {
  schemaVersion: 1;
  devices: StoredTrustedDevice[];
};

type PairingCodeState = {
  id: string;
  code: string;
  expiresAtMs: number;
};

type PairingAttemptState = {
  windowStartedAtMs: number;
  attempts: number;
};

export type DeviceAuthPrincipal =
  | { kind: "management" }
  | { kind: "local" }
  | { kind: "device"; device: TrustedDeviceDescriptor };

export interface DeviceAuthManagerOptions {
  rootDir?: string;
  now?: () => number;
  maxPairingAttemptKeys?: number;
}

function resolveRahHome(): string {
  return process.env.RAH_HOME
    ? path.resolve(process.env.RAH_HOME)
    : path.join(os.homedir(), ".rah");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function publicDevice(device: StoredTrustedDevice): TrustedDeviceDescriptor {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const entry of header?.split(";") ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!name) {
      continue;
    }
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || undefined;
}

function requestDeviceToken(req: IncomingMessage): string | undefined {
  return bearerToken(req) ?? parseCookieHeader(req.headers.cookie).get(DEVICE_COOKIE_NAME);
}

function requestHostname(req: IncomingMessage): string | null {
  const host = req.headers.host?.trim();
  if (!host) {
    return null;
  }
  try {
    return new URL(`http://${host}`).hostname
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/\.$/, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

function hasProxyForwardingHeaders(req: IncomingMessage): boolean {
  return Object.keys(req.headers).some((name) =>
    name === "forwarded" ||
    name === "via" ||
    name === "x-real-ip" ||
    name === "cf-connecting-ip" ||
    name === "true-client-ip" ||
    name === "fly-client-ip" ||
    name === "proxy-connection" ||
    name.startsWith("x-forwarded-") ||
    name.startsWith("tailscale-user-"),
  );
}

function isDirectLoopbackRequest(req: IncomingMessage): boolean {
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress) || hasProxyForwardingHeaders(req)) {
    return false;
  }
  const hostname = requestHostname(req);
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function sanitizeDeviceName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Device name is required.");
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Device name is required.");
  }
  if (normalized.length > MAX_DEVICE_NAME_LENGTH) {
    throw new Error(`Device name must be ${MAX_DEVICE_NAME_LENGTH} characters or fewer.`);
  }
  return normalized;
}

function parsePairDeviceRequest(value: unknown): PairDeviceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pairing code and device name are required.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !/^\d{8}$/.test(record.code.trim())) {
    throw new Error("Pairing code must contain 8 digits.");
  }
  return {
    code: record.code.trim(),
    name: sanitizeDeviceName(record.name),
  };
}

function parseStoredRegistry(raw: string): StoredDeviceRegistry {
  const parsed = JSON.parse(raw) as Partial<StoredDeviceRegistry>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.devices)) {
    throw new Error("Trusted device registry has an unsupported format.");
  }
  const devices = parsed.devices.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Trusted device registry contains an invalid device.");
    }
    const device = value as Partial<StoredTrustedDevice>;
    if (
      typeof device.id !== "string" ||
      typeof device.name !== "string" ||
      typeof device.tokenHash !== "string" ||
      typeof device.createdAt !== "string" ||
      typeof device.lastSeenAt !== "string"
    ) {
      throw new Error("Trusted device registry contains an invalid device.");
    }
    return {
      id: device.id,
      name: device.name,
      tokenHash: device.tokenHash,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      ...(typeof device.userAgent === "string" ? { userAgent: device.userAgent } : {}),
    };
  });
  return { schemaVersion: 1, devices };
}

function cookieHeader(req: IncomingMessage, token: string, maxAgeSeconds: number): string {
  const secure = requestProtocol(req) === "https";
  return [
    `${DEVICE_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function remoteAttemptKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

export class DeviceAuthManager {
  readonly rootDir: string;
  readonly registryPath: string;
  readonly managementTokenPath: string;

  private readonly now: () => number;
  private readonly maxPairingAttemptKeys: number;
  private registry: StoredDeviceRegistry;
  private readonly managementToken: string;
  private pairingCode: PairingCodeState | null = null;
  private readonly pairingAttempts = new Map<string, PairingAttemptState>();
  private readonly revocationListeners = new Map<string, Set<() => void>>();

  constructor(options: DeviceAuthManagerOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(resolveRahHome(), "auth");
    this.registryPath = path.join(this.rootDir, "devices.json");
    this.managementTokenPath = path.join(this.rootDir, "management-token");
    this.now = options.now ?? Date.now;
    this.maxPairingAttemptKeys = Math.max(
      1,
      options.maxPairingAttemptKeys ?? DEFAULT_MAX_PAIRING_ATTEMPT_KEYS,
    );
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    chmodSync(this.rootDir, 0o700);
    this.registry = this.readRegistry();
    this.managementToken = this.readOrCreateManagementToken();
  }

  authenticate(req: IncomingMessage): DeviceAuthPrincipal | null {
    const token = requestDeviceToken(req);
    if (
      token &&
      constantTimeEqual(token, this.managementToken) &&
      isLocalMachineRemoteAddress(req.socket.remoteAddress)
    ) {
      return { kind: "management" };
    }
    if (token) {
      const hash = tokenHash(token);
      const stored = this.registry.devices.find((device) => constantTimeEqual(device.tokenHash, hash));
      if (stored) {
        this.touchDevice(stored);
        return { kind: "device", device: publicDevice(stored) };
      }
    }
    return isDirectLoopbackRequest(req) ? { kind: "local" } : null;
  }

  status(req: IncomingMessage): DeviceAuthStatusResponse {
    const principal = this.authenticate(req);
    return {
      authenticated: principal !== null,
      hasTrustedDevices: this.registry.devices.length > 0,
      ...(principal?.kind === "device" ? { device: principal.device } : {}),
    };
  }

  createPairingCode(): PairingCodeResponse {
    const id = randomUUID();
    const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    const expiresAtMs = this.now() + PAIRING_CODE_TTL_MS;
    this.pairingCode = { id, code, expiresAtMs };
    this.pairingAttempts.clear();
    return { id, code, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  pairingCodeStatus(id: string): PairingCodeStatusResponse {
    const activeCode = this.pairingCode;
    if (activeCode && activeCode.expiresAtMs <= this.now()) {
      this.pairingCode = null;
      this.pairingAttempts.clear();
      return { active: false };
    }
    return { active: activeCode?.id === id };
  }

  pair(req: IncomingMessage, input: PairDeviceRequest): { response: PairDeviceResponse; token: string } {
    const activeCode = this.pairingCode;
    if (!activeCode || activeCode.expiresAtMs <= this.now()) {
      this.pairingCode = null;
      this.pairingAttempts.clear();
      throw new Error("Pairing code is missing or expired.");
    }
    this.assertPairingAttemptAllowed(req);
    if (!constantTimeEqual(activeCode.code, input.code)) {
      throw new Error("Pairing code is invalid.");
    }

    const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    const nowIso = new Date(this.now()).toISOString();
    const userAgent = typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].slice(0, MAX_USER_AGENT_LENGTH)
      : undefined;
    const stored: StoredTrustedDevice = {
      id: randomUUID(),
      name: sanitizeDeviceName(input.name),
      tokenHash: tokenHash(token),
      createdAt: nowIso,
      lastSeenAt: nowIso,
      ...(userAgent ? { userAgent } : {}),
    };
    this.registry.devices.push(stored);
    this.writeRegistry();
    this.pairingCode = null;
    this.pairingAttempts.clear();
    return {
      token,
      response: { authenticated: true, device: publicDevice(stored) },
    };
  }

  listDevices(principal: DeviceAuthPrincipal): ListTrustedDevicesResponse {
    return {
      devices: [...this.registry.devices]
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
        .map(publicDevice),
      ...(principal.kind === "device" ? { currentDeviceId: principal.device.id } : {}),
    };
  }

  revokeDevice(principal: DeviceAuthPrincipal, deviceId: string): RevokeTrustedDeviceResponse {
    const index = this.registry.devices.findIndex((device) => device.id === deviceId);
    if (index < 0) {
      throw new Error("Trusted device was not found.");
    }
    this.registry.devices.splice(index, 1);
    this.writeRegistry();
    for (const listener of this.revocationListeners.get(deviceId) ?? []) {
      listener();
    }
    this.revocationListeners.delete(deviceId);
    return {
      ok: true,
      revokedCurrentDevice: principal.kind === "device" && principal.device.id === deviceId,
    };
  }

  deviceCookie(req: IncomingMessage, token: string): string {
    return cookieHeader(req, token, 365 * 24 * 60 * 60);
  }

  clearDeviceCookie(req: IncomingMessage): string {
    return cookieHeader(req, "", 0);
  }

  subscribeDeviceRevocation(deviceId: string, listener: () => void): () => void {
    const listeners = this.revocationListeners.get(deviceId) ?? new Set<() => void>();
    listeners.add(listener);
    this.revocationListeners.set(deviceId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.revocationListeners.delete(deviceId);
      }
    };
  }

  private readRegistry(): StoredDeviceRegistry {
    if (!existsSync(this.registryPath)) {
      return { schemaVersion: 1, devices: [] };
    }
    try {
      return parseStoredRegistry(readFileSync(this.registryPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read trusted device registry at ${this.registryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private readOrCreateManagementToken(): string {
    if (existsSync(this.managementTokenPath)) {
      const existing = readFileSync(this.managementTokenPath, "utf8").trim();
      if (existing.length < 32) {
        throw new Error(`RAH management token is invalid: ${this.managementTokenPath}`);
      }
      chmodSync(this.managementTokenPath, 0o600);
      return existing;
    }
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    writeFileSync(this.managementTokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.managementTokenPath, 0o600);
    return token;
  }

  private writeRegistry(): void {
    const tmpPath = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.registry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.registryPath);
  }

  private touchDevice(device: StoredTrustedDevice): void {
    const previous = Date.parse(device.lastSeenAt);
    const now = this.now();
    if (Number.isFinite(previous) && now - previous < LAST_SEEN_WRITE_INTERVAL_MS) {
      return;
    }
    device.lastSeenAt = new Date(now).toISOString();
    this.writeRegistry();
  }

  private assertPairingAttemptAllowed(req: IncomingMessage): void {
    const key = remoteAttemptKey(req);
    const now = this.now();
    for (const [attemptKey, state] of this.pairingAttempts) {
      if (now - state.windowStartedAtMs >= PAIRING_ATTEMPT_WINDOW_MS) {
        this.pairingAttempts.delete(attemptKey);
      }
    }
    const current = this.pairingAttempts.get(key);
    if (!current) {
      if (this.pairingAttempts.size >= this.maxPairingAttemptKeys) {
        throw new Error("Too many pairing attempts from distinct network sources. Try again later.");
      }
      this.pairingAttempts.set(key, { windowStartedAtMs: now, attempts: 1 });
      return;
    }
    current.attempts += 1;
    if (current.attempts > MAX_PAIRING_ATTEMPTS_PER_WINDOW) {
      throw new Error("Too many pairing attempts. Generate a new code and try again.");
    }
  }
}

export async function handleDeviceAuthRequest(args: {
  auth: DeviceAuthManager;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}): Promise<boolean> {
  const { auth, req, res, url } = args;
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/api/auth/status") {
    res.setHeader("cache-control", "no-store");
    writeJson(req, res, 200, auth.status(req));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/pair") {
    try {
      const input = parsePairDeviceRequest(await readJsonBody(req));
      const paired = auth.pair(req, input);
      res.setHeader("set-cookie", auth.deviceCookie(req, paired.token));
      res.setHeader("cache-control", "no-store");
      writeJson(req, res, 200, paired.response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(req, res, message.startsWith("Too many pairing attempts") ? 429 : 400, {
        error: message,
      });
    }
    return true;
  }

  if (!pathname.startsWith("/api/auth/")) {
    return false;
  }

  const principal = auth.authenticate(req);
  if (!principal) {
    writeJson(req, res, 401, { error: "This device is not trusted by RAH." });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/auth/pairing-code") {
    res.setHeader("cache-control", "no-store");
    writeJson(req, res, 200, auth.createPairingCode());
    return true;
  }

  const pairingStatusMatch = /^\/api\/auth\/pairing-code\/([^/]+)\/status$/.exec(pathname);
  if (req.method === "GET" && pairingStatusMatch) {
    res.setHeader("cache-control", "no-store");
    writeJson(
      req,
      res,
      200,
      auth.pairingCodeStatus(decodeURIComponent(pairingStatusMatch[1]!)),
    );
    return true;
  }

  if (req.method === "GET" && pathname === "/api/auth/devices") {
    res.setHeader("cache-control", "no-store");
    writeJson(req, res, 200, auth.listDevices(principal));
    return true;
  }

  const revokeMatch = /^\/api\/auth\/devices\/([^/]+)$/.exec(pathname);
  if (req.method === "DELETE" && revokeMatch) {
    try {
      const deviceId = decodeURIComponent(revokeMatch[1]!);
      const response = auth.revokeDevice(principal, deviceId);
      if (response.revokedCurrentDevice) {
        res.setHeader("set-cookie", auth.clearDeviceCookie(req));
      }
      writeJson(req, res, 200, response);
    } catch (error) {
      writeJson(req, res, 404, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  writeJson(req, res, 404, { error: "Unknown authentication endpoint." });
  return true;
}
