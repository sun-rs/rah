import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type KeyboardEventHandler,
  type TextareaHTMLAttributes,
} from "react";

const TEXTAREA_TEXT_LAYOUT_CLASS_NAME =
  "whitespace-pre-wrap break-words";

export const TokenizedTextarea = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
    disabled?: boolean;
    rows?: number;
    placeholder?: string;
    textareaClassName: string;
    contentClassName: string;
} & Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, "spellCheck">
>(function TokenizedTextarea(props, forwardedRef) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement, []);

  // Auto-resize on iOS and other browsers
  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    const computed = window.getComputedStyle(el);
    const minHeight = Number.parseFloat(computed.minHeight) || 0;
    const maxHeight = Number.parseFloat(computed.maxHeight) || Number.POSITIVE_INFINITY;
    const borderHeight =
      (Number.parseFloat(computed.borderTopWidth) || 0) +
      (Number.parseFloat(computed.borderBottomWidth) || 0);

    // Lock the collapsed state to the same fixed height as the round controls.
    // Only grow once the content truly exceeds the single-line box.
    const collapsedHeight = Math.ceil(minHeight);
    el.style.height = `${collapsedHeight}px`;

    const requiredContentHeight = Math.ceil(el.scrollHeight);
    const collapsedContentHeight = Math.max(0, collapsedHeight - borderHeight);
    const shouldGrow = requiredContentHeight > collapsedContentHeight + 1;
    const expandedHeight = requiredContentHeight + borderHeight;
    const nextHeight = shouldGrow
      ? Math.max(collapsedHeight, Math.min(maxHeight, expandedHeight))
      : collapsedHeight;

    el.style.height = `${nextHeight}px`;
  };

  useEffect(() => {
    adjustHeight();
  }, [props.value]);

  return (
    <div className="relative flex-1 min-w-0">
      <textarea
        ref={textareaRef}
        className={`${props.textareaClassName} ${TEXTAREA_TEXT_LAYOUT_CLASS_NAME} text-[var(--app-fg)] caret-[var(--app-fg)] selection:bg-primary/20`}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
          queueMicrotask(adjustHeight);
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
