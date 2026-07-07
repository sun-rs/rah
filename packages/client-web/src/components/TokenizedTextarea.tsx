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
const HEIGHT_CHANGE_EPSILON_PX = 4;

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
  const measurementRef = useRef<HTMLTextAreaElement | null>(null);
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

  const measureRequiredContentHeight = useCallback((el: HTMLTextAreaElement) => {
    let measurement = measurementRef.current;
    if (!measurement) {
      measurement = document.createElement("textarea");
      measurement.setAttribute("aria-hidden", "true");
      measurement.setAttribute("tabindex", "-1");
      measurement.readOnly = true;
      measurement.style.position = "fixed";
      measurement.style.left = "-10000px";
      measurement.style.top = "0";
      measurement.style.visibility = "hidden";
      measurement.style.pointerEvents = "none";
      measurement.style.overflow = "hidden";
      measurement.style.zIndex = "-1";
      document.body.appendChild(measurement);
      measurementRef.current = measurement;
    }

    const rect = el.getBoundingClientRect();
    measurement.className = el.className;
    measurement.rows = el.rows;
    measurement.value = el.value;
    measurement.style.width = `${Math.ceil(rect.width)}px`;
    measurement.style.height = "auto";
    return Math.ceil(measurement.scrollHeight);
  }, []);

  // Auto-resize on iOS and other browsers. Measure before paint so the chat
  // viewport never sees a transient one-line composer during IME updates.
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const computed = window.getComputedStyle(el);
    const minHeight = Number.parseFloat(computed.minHeight) || 0;
    const maxHeight = Number.parseFloat(computed.maxHeight) || Number.POSITIVE_INFINITY;
    const borderHeight =
      (Number.parseFloat(computed.borderTopWidth) || 0) +
      (Number.parseFloat(computed.borderBottomWidth) || 0);

    const collapsedHeight = Math.ceil(minHeight);
    const requiredContentHeight = measureRequiredContentHeight(el);
    const collapsedContentHeight = Math.max(0, collapsedHeight - borderHeight);
    const shouldGrow = requiredContentHeight > collapsedContentHeight + 1;
    const expandedHeight = requiredContentHeight + borderHeight;
    const nextHeight = shouldGrow
      ? Math.max(collapsedHeight, Math.min(maxHeight, expandedHeight))
      : collapsedHeight;

    const currentHeight = Math.ceil(el.getBoundingClientRect().height);
    const stableHeight =
      currentHeight > 0 && Math.abs(currentHeight - nextHeight) <= HEIGHT_CHANGE_EPSILON_PX
        ? currentHeight
        : nextHeight;
    el.style.height = `${stableHeight}px`;
  }, [measureRequiredContentHeight]);

  useLayoutEffect(() => {
    adjustHeight();
  }, [adjustHeight, props.textareaClassName, localValue]);

  useLayoutEffect(() => {
    return () => {
      measurementRef.current?.remove();
      measurementRef.current = null;
    };
  }, []);

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
        onCompositionEnd={(event) => {
          isComposingRef.current = false;
          const pendingExternalValue = pendingExternalValueRef.current;
          if (pendingExternalValue !== null) {
            pendingExternalValueRef.current = null;
            lastEmittedValueRef.current = pendingExternalValue;
            setLocalTextareaValue(pendingExternalValue);
            return;
          }
          const nextValue = event.currentTarget.value;
          setLocalTextareaValue(nextValue);
          emitChange(nextValue);
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
        onInput={adjustHeight}
      />
    </div>
  );
});
