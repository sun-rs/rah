import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const STRING_SOURCE_CHUNK_CHARS = 16 * 1024;
const OUTPUT_CHUNK_BYTES = 64 * 1024;
const YIELD_AFTER_BYTES = 256 * 1024;
const YIELD_AFTER_MS = 8;

type JsonContainer = "root" | "array" | "object";

function normalizedJsonValue(value: unknown, key: string): unknown {
  let candidate = value;
  if (
    candidate !== null &&
    (typeof candidate === "object" || typeof candidate === "bigint")
  ) {
    const toJSON = (candidate as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      candidate = toJSON.call(candidate, key);
    }
  }
  if (
    candidate instanceof Number ||
    candidate instanceof String ||
    candidate instanceof Boolean
  ) {
    return candidate.valueOf();
  }
  return candidate;
}

function isOmittedJsonValue(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  );
}

function* jsonStringTokens(value: string): Generator<string> {
  if (value.length <= STRING_SOURCE_CHUNK_CHARS) {
    yield JSON.stringify(value);
    return;
  }
  yield "\"";
  for (let offset = 0; offset < value.length; offset += STRING_SOURCE_CHUNK_CHARS) {
    const serialized = JSON.stringify(
      value.slice(offset, offset + STRING_SOURCE_CHUNK_CHARS),
    );
    yield serialized.slice(1, -1);
  }
  yield "\"";
}

function* jsonValueTokens(
  original: unknown,
  key: string,
  container: JsonContainer,
  ancestors: Set<object>,
  alreadyNormalized = false,
): Generator<string, boolean> {
  const value = alreadyNormalized ? original : normalizedJsonValue(original, key);
  if (isOmittedJsonValue(value)) {
    if (container === "array") {
      yield "null";
      return true;
    }
    return false;
  }
  if (value === null) {
    yield "null";
    return true;
  }

  switch (typeof value) {
    case "string":
      yield* jsonStringTokens(value);
      return true;
    case "number":
      yield Number.isFinite(value) ? String(value) : "null";
      return true;
    case "boolean":
      yield value ? "true" : "false";
      return true;
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "object":
      break;
    default:
      return false;
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) {
          yield ",";
        }
        yield* jsonValueTokens(value[index], String(index), "array", ancestors);
      }
      yield "]";
      return true;
    }

    yield "{";
    let emitted = 0;
    for (const propertyKey of Object.keys(value)) {
      const propertyValue = normalizedJsonValue(
        (value as Record<string, unknown>)[propertyKey],
        propertyKey,
      );
      if (isOmittedJsonValue(propertyValue)) {
        continue;
      }
      if (emitted > 0) {
        yield ",";
      }
      yield* jsonStringTokens(propertyKey);
      yield ":";
      yield* jsonValueTokens(
        propertyValue,
        propertyKey,
        "object",
        ancestors,
        true,
      );
      emitted += 1;
    }
    yield "}";
    return true;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Incrementally serializes protocol payloads and regularly yields to the event
 * loop. This prevents a large history response from monopolizing the daemon
 * while preserving JSON.stringify-compatible output for ordinary JSON values.
 */
export async function* streamJsonChunks(
  value: unknown,
): AsyncGenerator<Buffer> {
  const tokens = jsonValueTokens(value, "", "root", new Set<object>());
  let pending: string[] = [];
  let pendingBytes = 0;
  let bytesSinceYield = 0;
  let yieldedAt = Date.now();

  for (const token of tokens) {
    pending.push(token);
    pendingBytes += Buffer.byteLength(token, "utf8");
    if (pendingBytes < OUTPUT_CHUNK_BYTES) {
      continue;
    }
    const chunk = Buffer.from(pending.join(""), "utf8");
    pending = [];
    pendingBytes = 0;
    bytesSinceYield += chunk.byteLength;
    yield chunk;
    const now = Date.now();
    if (
      bytesSinceYield >= YIELD_AFTER_BYTES ||
      now - yieldedAt >= YIELD_AFTER_MS
    ) {
      bytesSinceYield = 0;
      yieldedAt = now;
      await yieldToEventLoop();
    }
  }

  if (pendingBytes > 0) {
    yield Buffer.from(pending.join(""), "utf8");
  }
}
