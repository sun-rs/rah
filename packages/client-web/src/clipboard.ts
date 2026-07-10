import { writeHostClipboard } from "./api";

export type CopyTextResult = "copied" | "failed";

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function canUseHostClipboardFallback(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  return isLoopbackHostname(window.location.hostname);
}

function copyTextWithSelection(value: string): boolean {
  if (typeof document === "undefined" || !document.body) {
    return false;
  }
  const previousActiveElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const previousSelection =
    typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
  const previousRanges =
    previousSelection !== null
      ? Array.from({ length: previousSelection.rangeCount }, (_, index) =>
          previousSelection.getRangeAt(index).cloneRange(),
        )
      : [];
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "0";
  textarea.style.top = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.fontSize = "16px";
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previousSelection !== null) {
      previousSelection.removeAllRanges();
      for (const range of previousRanges) {
        previousSelection.addRange(range);
      }
    }
    previousActiveElement?.focus({ preventScroll: true });
  }
}

export async function copyTextToClipboard(value: string): Promise<CopyTextResult> {
  if (!value) {
    return "failed";
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return "copied";
    }
  } catch {
    // Fall through to gesture-based and host fallbacks.
  }
  if (copyTextWithSelection(value)) {
    return "copied";
  }
  if (canUseHostClipboardFallback()) {
    try {
      await writeHostClipboard(value);
      return "copied";
    } catch {
      return "failed";
    }
  }
  return "failed";
}
