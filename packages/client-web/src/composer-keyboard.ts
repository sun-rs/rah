import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function isCompositionKeyboardEvent(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
): boolean {
  const nativeEvent = event.nativeEvent as KeyboardEvent;
  return nativeEvent.isComposing || nativeEvent.keyCode === 229;
}

export function isTouchPrimaryInput(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true
  );
}

export function shouldSubmitComposerOnEnter(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !isCompositionKeyboardEvent(event) &&
    !isTouchPrimaryInput()
  );
}
