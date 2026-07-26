const EXACT_STRING_BYTE_LENGTH_LIMIT = 64 * 1024;
export const DEFAULT_JSON_SIZE_BUDGET_BYTES = 8 * 1024 * 1024;

function addBoundedBytes(current: number, addition: number, limit: number): number {
  if (addition > limit - current) {
    return limit + 1;
  }
  return current + addition;
}

function boundedStringByteLength(value: string, limit: number): number {
  if (value.length > limit) {
    return limit + 1;
  }
  if (value.length <= EXACT_STRING_BYTE_LENGTH_LIMIT) {
    return Math.min(limit + 1, Buffer.byteLength(value, "utf8"));
  }
  // Avoid scanning multi-megabyte provider strings on the daemon event loop.
  // Three bytes per UTF-16 code unit is conservative for ordinary JSON text.
  return Math.min(limit + 1, value.length * 3);
}

/**
 * Estimate JSON retention/transport cost without constructing a second,
 * potentially multi-megabyte JSON string. Traversal stops as soon as the
 * caller's budget is exceeded.
 *
 * The return value is exact enough for values within the budget. A value of
 * `limit + 1` means "larger than this budget"; callers must not interpret it as
 * the complete serialized size.
 */
export function boundedJsonByteLength(value: unknown, limit: number): number {
  const budget = Math.max(1, Math.floor(limit));
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown, remaining: number): number => {
    if (remaining <= 0) {
      return remaining + 1;
    }
    if (candidate === null) {
      return 4;
    }
    switch (typeof candidate) {
      case "string":
        return addBoundedBytes(
          2,
          boundedStringByteLength(candidate, Math.max(1, remaining - 2)),
          remaining,
        );
      case "number":
        return Number.isFinite(candidate) ? String(candidate).length : 4;
      case "boolean":
        return candidate ? 4 : 5;
      case "undefined":
      case "function":
      case "symbol":
        return 4;
      case "bigint":
        return Math.min(remaining + 1, candidate.toString().length + 2);
      case "object":
        break;
    }

    const object = candidate as object;
    if (seen.has(object)) {
      return remaining + 1;
    }
    seen.add(object);
    let bytes = 2;
    try {
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          bytes = addBoundedBytes(bytes, index === 0 ? 0 : 1, remaining);
          if (bytes > remaining) {
            break;
          }
          bytes = addBoundedBytes(
            bytes,
            visit(candidate[index], remaining - bytes),
            remaining,
          );
          if (bytes > remaining) {
            break;
          }
        }
      } else {
        let keyCount = 0;
        for (const key in candidate as Record<string, unknown>) {
          if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
            continue;
          }
          bytes = addBoundedBytes(bytes, keyCount === 0 ? 0 : 1, remaining);
          bytes = addBoundedBytes(
            bytes,
            boundedStringByteLength(key, Math.max(1, remaining - bytes)) + 3,
            remaining,
          );
          if (bytes > remaining) {
            break;
          }
          bytes = addBoundedBytes(
            bytes,
            visit(
              (candidate as Record<string, unknown>)[key],
              remaining - bytes,
            ),
            remaining,
          );
          keyCount += 1;
          if (bytes > remaining) {
            break;
          }
        }
      }
    } catch {
      return remaining + 1;
    } finally {
      seen.delete(object);
    }
    return bytes;
  };

  return Math.min(budget + 1, visit(value, budget));
}

export function approximateJsonByteLength(
  value: unknown,
  limit = DEFAULT_JSON_SIZE_BUDGET_BYTES,
): number {
  return boundedJsonByteLength(value, limit);
}
