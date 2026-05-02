import type { IncomingMessage, ServerResponse } from "node:http";
import { applyCorsHeaders } from "./http-server-cors";

export const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

export type JsonHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  body: unknown,
) => Promise<void>;

export function requestErrorStatus(error: unknown): number {
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
    message.includes("Path is not a file.") ||
    message.includes("Workspace directory is required.") ||
    message.includes("Cannot remove a workspace with active live sessions.")
  ) {
    return 400;
  }
  if (message.startsWith("Unknown session ")) {
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
      } catch (error) {
        reject(error);
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

export function writeJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  applyCorsHeaders(req, res);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
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
