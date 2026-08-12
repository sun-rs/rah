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
  const scopeKeyRef = useRef(props.scopeKey);

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
    isComposingRef.current = false;
    pendingExternalValueRef.current = null;
    lastEmittedValueRef.current = props.value;
    setLocalTextareaValue(props.value);
  }, [props.scopeKey, props.value, setLocalTextareaValue]);

  useEffect(() => {
    if (isComposingRef.current) {
      if (props.value !== lastEmittedValueRef.current) {
        pendingExternalValueRef.current = props.value;
      }
      return;
    }
    if (props.value === lastEmittedValueRef.current) {
      return;
    }
    lastEmittedValueRef.current = props.value;
    setLocalTextareaValue(props.value);
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
          const nextValue = event.currentTarget.value;
          const nativeEvent = event.nativeEvent as InputEvent;
          setLocalTextareaValue(nextValue);
          if (!isComposingRef.current && !nativeEvent.isComposing) {
            emitChange(nextValue);
          }
        }}
        onCompositionStart={() => {
          isComposingRef.current = true;
          pendingExternalValueRef.current = null;
        }}
        onCompositionUpdate={() => {
          adjustHeight();
          scheduleHeightAdjustment();
        }}
        onCompositionEnd={(event) => {
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
          props.onKeyDown?.(event);
        }}
        onPaste={props.onPaste}
        disabled={props.disabled}
        rows={props.rows}
        spellCheck={props.spellCheck}
        onFocus={() => {
          adjustHeight();
          scheduleHeightAdjustment();
        }}
        onInput={() => {
          adjustHeight();
          scheduleHeightAdjustment();
        }}
      />
    </div>
  );
});
