export const COMPOSER_FOCUS_PRESERVE_SELECTOR =
  '[data-composer-focus-preserve="true"], [data-composer-control]';
export const COMPOSER_FOCUS_RELEASE_SELECTOR =
  '[data-composer-focus-release="true"]';
export const COMPOSER_REVEALED_CONTROL_SELECTOR = '[data-composer-control]';
export const COMPOSER_INTERACTIVE_SELECTOR =
  "button,a,input,select,summary,[role='button'],[role='option'],[contenteditable='true']";

export interface ComposerExpansionGesture {
  pointerId: number;
}

export function beginComposerExpansionGesture(args: {
  isPwa: boolean;
  composerExpanded: boolean;
  onInteractiveControl: boolean;
  pointerId: number;
}): ComposerExpansionGesture | null {
  if (!args.isPwa || args.composerExpanded || args.onInteractiveControl) {
    return null;
  }
  return { pointerId: args.pointerId };
}

export function shouldSuppressComposerControlClickAfterExpansion(args: {
  gesture: ComposerExpansionGesture | null;
  onRevealedControl: boolean;
  pointerGenerated: boolean;
}): boolean {
  return (
    args.gesture !== null &&
    args.onRevealedControl &&
    args.pointerGenerated
  );
}

export type ComposerPointerFocusIntent =
  | "none"
  | "textarea"
  | "focus-textarea"
  | "preserve-textarea"
  | "release-textarea"
  | "outside";

export function resolveComposerPointerFocusIntent(args: {
  isPwa: boolean;
  textareaIsActive: boolean;
  insideComposer: boolean;
  onTextarea: boolean;
  onInteractiveControl: boolean;
  onFocusPreservingPortal: boolean;
  explicitlyReleasesFocus: boolean;
}): ComposerPointerFocusIntent {
  if (args.explicitlyReleasesFocus) {
    return "release-textarea";
  }
  if (args.onTextarea) {
    return "textarea";
  }

  const editingSessionActive = args.isPwa || args.textareaIsActive;
  if (!editingSessionActive) {
    return "none";
  }
  if (args.onFocusPreservingPortal) {
    return "preserve-textarea";
  }
  if (args.insideComposer) {
    return args.onInteractiveControl
      ? "preserve-textarea"
      : "focus-textarea";
  }
  return args.isPwa ? "outside" : "none";
}

type PointerPathEvent = Pick<Event, "target"> &
  Partial<Pick<Event, "composedPath">>;

function composerPointerPath(event: PointerPathEvent): readonly EventTarget[] {
  if (typeof event.composedPath === "function") {
    return event.composedPath();
  }
  return event.target ? [event.target] : [];
}

export function composerPointerTargetElement(
  event: PointerPathEvent,
): Element | null {
  for (const item of composerPointerPath(event)) {
    if (item instanceof Element) {
      return item;
    }
  }
  const target = event.target;
  if (target instanceof Element) {
    return target;
  }
  return target instanceof Node ? target.parentElement : null;
}

export function composerPointerPathMatches(
  event: PointerPathEvent,
  selector: string,
): boolean {
  for (const item of composerPointerPath(event)) {
    if (item instanceof Element && item.matches(selector)) {
      return true;
    }
  }
  return composerPointerTargetElement(event)?.closest(selector) !== null;
}
