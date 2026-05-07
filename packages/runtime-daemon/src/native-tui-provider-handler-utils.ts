import type { NativeTuiOutputObservation } from "./native-tui-provider-runtime-types";

export const EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION: NativeTuiOutputObservation = {
  promptClean: false,
  binding: null,
};

function normalizeNativeTuiDirectory(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("/private/var/") ? trimmed.slice("/private".length) : trimmed;
}

export function sameNativeTuiDirectory(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const normalizedLeft = normalizeNativeTuiDirectory(left);
  const normalizedRight = normalizeNativeTuiDirectory(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft === normalizedRight;
}
