import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type KeyboardEventHandler,
  type TextareaHTMLAttributes,
} from "react";

const TEXTAREA_TEXT_LAYOUT_CLASS_NAME =
  "whitespace-pre-wrap break-words";
const HEIGHT_CHANGE_EPSILON_PX = 4;

export const TokenizedTextarea = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
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

  useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement, []);

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
  }, [adjustHeight, props.value]);

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
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
        }}
        onKeyDown={props.onKeyDown}
        disabled={props.disabled}
        rows={props.rows}
        spellCheck={props.spellCheck}
        onInput={adjustHeight}
      />
    </div>
  );
});
