import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ClipboardEventHandler,
  type TextareaHTMLAttributes,
} from "react";

const TEXTAREA_TEXT_LAYOUT_CLASS_NAME =
  "whitespace-pre-wrap break-words";

export type ExternalTextareaValueSync =
  | { kind: "ignore" }
  | { kind: "defer"; value: string }
  | { kind: "apply"; value: string; discardCompositionEnd: boolean };

export function resolveExternalTextareaValueSync(args: {
  externalValue: string;
  lastEmittedValue: string;
  isComposing: boolean;
}): ExternalTextareaValueSync {
  if (args.externalValue === args.lastEmittedValue) {
    return { kind: "ignore" };
  }
  if (args.isComposing && args.externalValue !== "") {
    return { kind: "defer", value: args.externalValue };
  }
  return {
    kind: "apply",
    value: args.externalValue,
    // Clicking Send can make Mobile Safari emit compositionend before React
    // commits the parent-owned clear. Remember every accepted non-empty ->
    // empty transition, not only the subset that still reports composing.
    discardCompositionEnd:
      args.externalValue === "" && args.lastEmittedValue !== "",
  };
}

export function preserveDiscardedCompositionAcrossScopeChange(args: {
  discardCompositionEnd: boolean;
  isComposing: boolean;
}): boolean {
  return args.discardCompositionEnd || args.isComposing;
}

export function shouldDiscardOrphanedCompositionInput(args: {
  externalValue: string;
  compositionStartedHere: boolean;
  nativeIsComposing?: boolean;
  inputType?: string | null;
}): boolean {
  return (
    args.externalValue === "" &&
    !args.compositionStartedHere &&
    (args.nativeIsComposing === true || args.inputType === "insertCompositionText")
  );
}

export const TokenizedTextarea = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    scopeKey: string;
    onChange: (value: string) => void;
    onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
    onPaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined;
    disabled?: boolean;
    rows?: number;
    placeholder?: string;
    ariaLabel?: string;
    textareaClassName: string;
    contentClassName: string;
    wrapperClassName?: string;
  } & Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, "spellCheck">
>(function TokenizedTextarea(props, forwardedRef) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const heightFrameRef = useRef<number | null>(null);
  const [localValue, setLocalValue] = useState(props.value);
  const lastEmittedValueRef = useRef(props.value);
  const isComposingRef = useRef(false);
  const pendingExternalValueRef = useRef<string | null>(null);
  const discardCompositionEndRef = useRef(false);
  const externalValueRef = useRef(props.value);
  const scopeKeyRef = useRef(props.scopeKey);
  externalValueRef.current = props.value;

  useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement, []);

  const setLocalTextareaValue = useCallback((value: string) => {
    setLocalValue(value);
  }, []);

  const emitChange = useCallback((value: string) => {
    lastEmittedValueRef.current = value;
    props.onChange(value);
  }, [props.onChange]);

  useLayoutEffect(() => {
    if (scopeKeyRef.current === props.scopeKey) {
      return;
    }
    scopeKeyRef.current = props.scopeKey;
    // A stored-history Resume replaces the temporary replay id with a new
    // live runtime id. That scope change can happen between an accepted Send
    // and Mobile Safari's late compositionend/input pair. Preserve the
    // discard boundary across the identity handoff or the submitted question
    // is written back into the new live Session composer.
    discardCompositionEndRef.current = preserveDiscardedCompositionAcrossScopeChange({
      discardCompositionEnd: discardCompositionEndRef.current,
      isComposing: isComposingRef.current,
    });
    isComposingRef.current = false;
    pendingExternalValueRef.current = null;
    lastEmittedValueRef.current = props.value;
    if (textareaRef.current && props.value === "") {
      textareaRef.current.value = "";
    }
    setLocalTextareaValue(props.value);
  }, [props.scopeKey, props.value, setLocalTextareaValue]);

  useLayoutEffect(() => {
    const sync = resolveExternalTextareaValueSync({
      externalValue: props.value,
      lastEmittedValue: lastEmittedValueRef.current,
      isComposing: isComposingRef.current,
    });
    if (sync.kind === "ignore") {
      return;
    }
    if (sync.kind === "defer") {
      pendingExternalValueRef.current = sync.value;
      return;
    }
    if (sync.discardCompositionEnd) {
      discardCompositionEndRef.current = true;
      isComposingRef.current = false;
      pendingExternalValueRef.current = null;
    }
    lastEmittedValueRef.current = sync.value;
    if (textareaRef.current && sync.value === "") {
      // Mobile Safari can retain the native composition buffer even after the
      // controlled value changes. Clear the live control at the same boundary
      // as the accepted Send so stale text cannot remain editable.
      textareaRef.current.value = "";
    }
    setLocalTextareaValue(sync.value);
  }, [props.value, setLocalTextareaValue]);

  // Measure the live control instead of a detached clone. Mobile Safari can
  // give detached textareas different font and wrapping metrics while the IME
  // is composing, which left the visible control stuck at one or two lines.
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const computed = window.getComputedStyle(el);
    const minHeight = Number.parseFloat(computed.minHeight) || 0;
    const cssMaxHeight =
      Number.parseFloat(computed.maxHeight) || Number.POSITIVE_INFINITY;
    const visualViewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const keyboardVisible = visualViewportHeight < window.innerHeight - 80;
    const keyboardAwareMaxHeight = keyboardVisible
      ? Math.max(minHeight * 3, Math.floor(visualViewportHeight * 0.42))
      : Number.POSITIVE_INFINITY;
    const maxHeight = Math.max(
      minHeight,
      Math.min(cssMaxHeight, keyboardAwareMaxHeight),
    );
    const borderHeight =
      (Number.parseFloat(computed.borderTopWidth) || 0) +
      (Number.parseFloat(computed.borderBottomWidth) || 0);
    const previousScrollTop = el.scrollTop;
    const previousScrollHeight = el.scrollHeight;
    const wasAtBottom =
      previousScrollTop + el.clientHeight >= previousScrollHeight - 4;

    el.style.height = `${Math.ceil(minHeight)}px`;
    el.style.overflowY = "hidden";
    const requiredHeight = Math.ceil(el.scrollHeight + borderHeight);
    const nextHeight = Math.max(minHeight, Math.min(maxHeight, requiredHeight));
    el.style.height = `${Math.ceil(nextHeight)}px`;
    const overflowed = requiredHeight > maxHeight + 1;
    el.style.overflowY = overflowed ? "auto" : "hidden";
    if (overflowed) {
      el.scrollTop = wasAtBottom ? el.scrollHeight : previousScrollTop;
    }
  }, []);

  const scheduleHeightAdjustment = useCallback(() => {
    if (heightFrameRef.current !== null) {
      window.cancelAnimationFrame(heightFrameRef.current);
    }
    heightFrameRef.current = window.requestAnimationFrame(() => {
      heightFrameRef.current = null;
      adjustHeight();
    });
  }, [adjustHeight]);

  useLayoutEffect(() => {
    adjustHeight();
  }, [adjustHeight, props.textareaClassName, localValue]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleHeightAdjustment);
    if (el.parentElement) {
      resizeObserver?.observe(el.parentElement);
    }
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", scheduleHeightAdjustment);
    visualViewport?.addEventListener("scroll", scheduleHeightAdjustment);
    window.addEventListener("resize", scheduleHeightAdjustment);
    return () => {
      resizeObserver?.disconnect();
      visualViewport?.removeEventListener("resize", scheduleHeightAdjustment);
      visualViewport?.removeEventListener("scroll", scheduleHeightAdjustment);
      window.removeEventListener("resize", scheduleHeightAdjustment);
      if (heightFrameRef.current !== null) {
        window.cancelAnimationFrame(heightFrameRef.current);
        heightFrameRef.current = null;
      }
    };
  }, [scheduleHeightAdjustment]);

  return (
    <div className={`relative flex-1 min-w-0 ${props.wrapperClassName ?? ""}`}>
      <textarea
        ref={textareaRef}
        className={`${props.textareaClassName} ${TEXTAREA_TEXT_LAYOUT_CLASS_NAME} text-[var(--app-fg)] caret-[var(--app-fg)] selection:bg-primary/20`}
        value={localValue}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        onChange={(event) => {
          const nativeEvent = event.nativeEvent as InputEvent;
          if (
            (discardCompositionEndRef.current &&
              (nativeEvent.isComposing ||
                nativeEvent.inputType === "insertCompositionText")) ||
            shouldDiscardOrphanedCompositionInput({
              externalValue: externalValueRef.current,
              compositionStartedHere: isComposingRef.current,
              nativeIsComposing: nativeEvent.isComposing,
              inputType: nativeEvent.inputType,
            })
          ) {
            // iOS may dispatch one final input event after Send cleared the
            // controlled draft but before compositionend. That event belongs
            // to the already-submitted composition and must not repopulate the
            // parent draft or the live textarea.
            const externalValue = externalValueRef.current;
            event.currentTarget.value = externalValue;
            setLocalTextareaValue(externalValue);
            return;
          }
          const nextValue = event.currentTarget.value;
          setLocalTextareaValue(nextValue);
          if (!isComposingRef.current && !nativeEvent.isComposing) {
            emitChange(nextValue);
          }
        }}
        onCompositionStart={() => {
          isComposingRef.current = true;
          discardCompositionEndRef.current = false;
          pendingExternalValueRef.current = null;
        }}
        onCompositionUpdate={() => {
          adjustHeight();
          scheduleHeightAdjustment();
        }}
        onCompositionEnd={(event) => {
          if (
            discardCompositionEndRef.current ||
            shouldDiscardOrphanedCompositionInput({
              externalValue: externalValueRef.current,
              compositionStartedHere: isComposingRef.current,
            })
          ) {
            discardCompositionEndRef.current = false;
            isComposingRef.current = false;
            pendingExternalValueRef.current = null;
            const externalValue = externalValueRef.current;
            // The native composition event mutates the textarea before React
            // receives it. State is already the submitted empty value, so a
            // no-op setState cannot repair that DOM mutation; reset the live
            // control explicitly at the event boundary.
            event.currentTarget.value = externalValue;
            lastEmittedValueRef.current = externalValue;
            setLocalTextareaValue(externalValue);
            scheduleHeightAdjustment();
            return;
          }
          isComposingRef.current = false;
          const pendingExternalValue = pendingExternalValueRef.current;
          if (pendingExternalValue !== null) {
            pendingExternalValueRef.current = null;
            lastEmittedValueRef.current = pendingExternalValue;
            setLocalTextareaValue(pendingExternalValue);
            scheduleHeightAdjustment();
            return;
          }
          const nextValue = event.currentTarget.value;
          setLocalTextareaValue(nextValue);
          emitChange(nextValue);
          scheduleHeightAdjustment();
        }}
        onKeyDown={(event) => {
          const nativeEvent = event.nativeEvent as KeyboardEvent;
          if (
            isComposingRef.current ||
            nativeEvent.isComposing ||
            nativeEvent.keyCode === 229
          ) {
            return;
          }
          // A trusted non-IME key begins a new edit after the accepted Send.
          // Do not let the old composition tombstone consume it.
          discardCompositionEndRef.current = false;
          props.onKeyDown?.(event);
        }}
        onPaste={(event) => {
          discardCompositionEndRef.current = false;
          props.onPaste?.(event);
        }}
        disabled={props.disabled}
        rows={props.rows}
        spellCheck={props.spellCheck}
        onFocus={() => {
          adjustHeight();
          scheduleHeightAdjustment();
        }}
        onInput={(event) => {
          const nativeEvent = event.nativeEvent as InputEvent;
          const orphanedComposition = shouldDiscardOrphanedCompositionInput({
            externalValue: externalValueRef.current,
            compositionStartedHere: isComposingRef.current,
            nativeIsComposing: nativeEvent.isComposing,
            inputType: nativeEvent.inputType,
          });
          const discardedSubmittedComposition =
            discardCompositionEndRef.current &&
            (nativeEvent.isComposing ||
              nativeEvent.inputType === "insertCompositionText");
          if (discardedSubmittedComposition || orphanedComposition) {
            event.currentTarget.value = externalValueRef.current;
          } else if (!isComposingRef.current) {
            discardCompositionEndRef.current = false;
          }
          adjustHeight();
          scheduleHeightAdjustment();
        }}
      />
    </div>
  );
});
