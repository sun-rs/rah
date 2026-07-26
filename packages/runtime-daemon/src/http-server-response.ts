import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, constants as zlibConstants } from "node:zlib";
import { boundedJsonByteLength } from "./bounded-json-size";
import { applyCorsHeaders } from "./http-server-cors";
import { streamJsonChunks } from "./json-response-stream";
import { SessionInputQueueConflictError } from "./session-input-queue";

export const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;
const MIN_GZIP_RESPONSE_BYTES = 16 * 1024;
const STREAM_JSON_RESPONSE_BYTES = 64 * 1024;

export type JsonHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  body: unknown,
) => Promise<void>;

export function requestErrorStatus(error: unknown): number {
  if (error instanceof SessionInputQueueConflictError) {
    return 409;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Cross-origin requests are not allowed.") ||
    message.includes("Missing required RAH client header.") ||
    message.includes("Host clipboard fallback is only available to local clients.") ||
    message.includes("Workspace directory is not registered.") ||
    message.includes("Requested workspace scope is outside the session workspace boundary.")
  ) {
    return 403;
  }
  if (message.includes("Request body too large.")) {
    return 413;
  }
  if (
    message.includes("is required") ||
    message.includes("Bad Request") ||
    message.includes("Queued message cannot be empty.") ||
    message.includes("Path is not a file.") ||
    message.includes("Workspace directory is required.") ||
    message.includes("is not a supported live provider.") ||
    message.includes("is not a supported running provider.") ||
    message.includes("Cannot remove a workspace with active running sessions.") ||
    message.includes("Only RAH-owned TUI mux sessions can be closed from diagnostics.") ||
    message.includes("This TUI mux session is managed by a running RAH session.")
  ) {
    return 400;
  }
  if (
    message.includes("does not hold input control") ||
    message.includes("is no longer queued") ||
    message.includes("does not support queued input")
  ) {
    return 409;
  }
  if (
    message.startsWith("Unknown session ") ||
    message.startsWith("Unknown attachment ") ||
    message.startsWith("Unknown turn artifact ") ||
    message.startsWith("Unknown turn file ") ||
    message.startsWith("Unknown manual model ") ||
    message.startsWith("Unknown manual model option ")
  ) {
    return 404;
  }
  return 500;
}

export function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const contentLength = req.headers["content-length"];
    let settled = false;
    let totalBytes = 0;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      chunks.splice(0, chunks.length);
      req.resume();
      reject(error);
    };

    if (typeof contentLength === "string") {
      const parsed = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        fail(new Error("Request body too large."));
        return;
      }
    }

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        fail(new Error("Request body too large."));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Bad Request: invalid JSON body."));
      }
    });
    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

export function readBinaryBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return readRequestBody(req, maxBytes);
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const contentLength = req.headers["content-length"];
    let settled = false;
    let totalBytes = 0;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      chunks.splice(0, chunks.length);
      req.resume();
      reject(error);
    };

    if (typeof contentLength === "string") {
      const parsed = Number.parseInt(contentLength, 10);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        fail(new Error("Request body too large."));
        return;
      }
    }

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        fail(new Error("Request body too large."));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

export function writeJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  applyCorsHeaders(req, res);
  const estimatedBytes = boundedJsonByteLength(
    payload,
    STREAM_JSON_RESPONSE_BYTES,
  );
  if (estimatedBytes <= STREAM_JSON_RESPONSE_BYTES) {
    const body = Buffer.from(JSON.stringify(payload));
    if (body.byteLength >= MIN_GZIP_RESPONSE_BYTES && requestAcceptsGzip(req)) {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
        "cache-control": "no-store",
        vary: "accept-encoding",
      });
      const gzip = createGzip({ level: zlibConstants.Z_BEST_SPEED });
      gzip.once("error", () => res.destroy());
      gzip.pipe(res);
      gzip.end(body);
      return;
    }
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.byteLength,
      "cache-control": "no-store",
      ...(body.byteLength >= MIN_GZIP_RESPONSE_BYTES
        ? { vary: "accept-encoding" }
        : {}),
    });
    res.end(body);
    return;
  }

  const gzipAccepted = requestAcceptsGzip(req);
  if (gzipAccepted) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      "cache-control": "no-store",
      vary: "accept-encoding",
    });
  } else {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      vary: "accept-encoding",
    });
  }
  const source = Readable.from(streamJsonChunks(payload));
  const transfer = gzipAccepted
    ? pipeline(
        source,
        createGzip({ level: zlibConstants.Z_BEST_SPEED }),
        res,
      )
    : pipeline(source, res);
  void transfer.catch(() => {
    if (!res.destroyed) {
      res.destroy();
    }
  });
}

function requestAcceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers["accept-encoding"];
  if (typeof header !== "string") {
    return false;
  }
  return header.split(",").some((entry) => {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") {
      return false;
    }
    return !parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?$/.test(parameter.trim()));
  });
}

export function writeText(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
): void {
  applyCorsHeaders(req, res);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
