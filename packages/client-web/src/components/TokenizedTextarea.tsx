import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type KeyboardEventHandler,
  type TextareaHTMLAttributes,
} from "react";

type TextSegment = {
  kind: "text" | "reference";
  value: string;
};

function tokenizeReferences(value: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /@(?:"[^"]+"|[^\s]+)/g;
  let lastIndex = 0;

  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({
        kind: "text",
        value: value.slice(lastIndex, start),
      });
    }
    segments.push({
      kind: "reference",
      value: match[0],
    });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < value.length) {
    segments.push({
      kind: "text",
      value: value.slice(lastIndex),
    });
  }

  return segments.length > 0 ? segments : [{ kind: "text", value }];
}

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
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const segments = useMemo(() => tokenizeReferences(props.value), [props.value]);

  useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement, []);

  const syncScroll = () => {
    if (!textareaRef.current || !mirrorRef.current) {
      return;
    }
    mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
    mirrorRef.current.scrollLeft = textareaRef.current.scrollLeft;
  };

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
      <div
        ref={mirrorRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
      >
        <div
          className={`${props.contentClassName} whitespace-pre-wrap break-words text-[var(--app-fg)]`}
        >
          {props.value ? (
            segments.map((segment, index) => (
              <span
                key={`${segment.kind}:${index}`}
                className={
                  segment.kind === "reference"
                    ? "font-medium text-sky-700 dark:text-sky-400"
                    : undefined
                }
              >
                {segment.value}
              </span>
            ))
          ) : (
            <span className="text-[var(--app-hint)]">{props.placeholder}</span>
          )}
          {"\n"}
        </div>
      </div>

      <textarea
        ref={textareaRef}
        className={`${props.textareaClassName} text-transparent caret-[var(--app-fg)] selection:bg-primary/20`}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
          queueMicrotask(adjustHeight);
        }}
        onKeyDown={props.onKeyDown}
        disabled={props.disabled}
        rows={props.rows}
        spellCheck={props.spellCheck}
        onScroll={syncScroll}
        onInput={adjustHeight}
      />
    </div>
  );
});
