import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type KeyboardEventHandler,
  type TextareaHTMLAttributes,
} from "react";

type Segment =
  | { kind: "text"; value: string }
  | { kind: "token"; value: string };

function isBoundaryCharacter(char: string | undefined): boolean {
  return char === undefined || /\s|[\([{]/.test(char);
}

function isLikelyFileReference(body: string): boolean {
  if (!body) {
    return false;
  }
  if (body.startsWith('"') && body.endsWith('"') && body.length > 1) {
    return true;
  }
  return (
    body.startsWith("./") ||
    body.startsWith("../") ||
    body.startsWith("/") ||
    body.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(body) ||
    body.includes("/") ||
    body.includes("\\") ||
    /\.[A-Za-z0-9_-]+$/.test(body)
  );
}

function tokenizeReferences(value: string): Segment[] {
  if (!value) {
    return [{ kind: "text", value: "" }];
  }
  const segments: Segment[] = [];
  let lastIndex = 0;

  let index = 0;
  while (index < value.length) {
    const atIndex = value.indexOf("@", index);
    if (atIndex < 0) {
      break;
    }
    if (!isBoundaryCharacter(value[atIndex - 1])) {
      index = atIndex + 1;
      continue;
    }

    let end = atIndex + 1;
    if (value[end] === '"') {
      end += 1;
      while (end < value.length && value[end] !== '"' && value[end] !== "\n") {
        end += 1;
      }
      if (value[end] === '"') {
        end += 1;
      }
    } else {
      while (end < value.length && !/[\s)\]},!?]/.test(value[end]!)) {
        end += 1;
      }
    }

    const token = value.slice(atIndex, end);
    const body = token.slice(1);
    if (!isLikelyFileReference(body)) {
      index = atIndex + 1;
      continue;
    }

    if (atIndex > lastIndex) {
      segments.push({ kind: "text", value: value.slice(lastIndex, atIndex) });
    }
    segments.push({ kind: "token", value: token });
    lastIndex = end;
    index = end;
  }

  if (lastIndex < value.length) {
    segments.push({ kind: "text", value: value.slice(lastIndex) });
  }
  return segments;
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
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    el.style.height = "auto";
    // Force synchronous layout recalculation so scrollHeight is accurate
    void el.offsetHeight;
    let nextHeight = Math.max(minHeight, Math.min(maxHeight, el.scrollHeight));
    // Strict snap: if the computed height is barely above minHeight (within
    // a quarter line), clamp it down. This prevents the textarea from being
    // 1–2 px taller than the adjacent buttons on empty or nearly-empty input.
    const snapThreshold = minHeight + lineHeight * 0.25;
    if (nextHeight <= snapThreshold) {
      nextHeight = minHeight;
    }
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
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-inherit"
      >
        <div
          className={`${props.contentClassName} whitespace-pre-wrap break-words text-[var(--app-fg)]`}
        >
          {props.value ? (
            <span>{props.value}</span>
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
