import {
  Suspense,
  isValidElement,
  lazy,
  memo,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { splitMarkdownBlocks } from "./markdown-blocks";

const ReactMarkdown = lazy(async () => ({
  default: (await import("react-markdown")).default,
}));

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textFromNode).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textFromNode(node.props.children);
  }
  return "";
}

function languageFromNode(node: ReactNode): string | null {
  const child = Array.isArray(node) ? node[0] : node;
  if (!isValidElement<{ className?: string }>(child)) {
    return null;
  }
  const className = child.props.className ?? "";
  const match = /(?:^|\s)language-([^\s]+)/.exec(className);
  return match?.[1] ?? null;
}

type MarkdownExtraProps = {
  node?: unknown;
};

function MarkdownPre({
  children,
  node: _node,
  ...preProps
}: ComponentPropsWithoutRef<"pre"> & MarkdownExtraProps) {
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => textFromNode(children), [children]);
  const language = useMemo(() => languageFromNode(children), [children]);

  const copyCode = () => {
    if (!code || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="prose-chat-codeblock">
      <div className="prose-chat-codeblock-header">
        <span>{language ?? "text"}</span>
        <button type="button" onClick={copyCode} title="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre {...preProps}>{children}</pre>
    </div>
  );
}

const markdownComponents: Components = {
  a({ node: _node, ...anchorProps }) {
    return <a {...anchorProps} target="_blank" rel="noreferrer" />;
  },
  pre: MarkdownPre,
  table({ node: _node, ...tableProps }) {
    return (
      <div className="prose-chat-table-wrapper">
        <table {...tableProps} />
      </div>
    );
  },
};

const remarkPlugins = [remarkGfm, remarkBreaks];

const MemoizedMarkdownBlock = memo(function MemoizedMarkdownBlock(props: {
  content: string;
}) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
      {props.content}
    </ReactMarkdown>
  );
});

function PlainMarkdownFallback(props: { blocks: string[]; className?: string }) {
  return (
    <div className={props.className}>
      {props.blocks.map((block, index) => (
        <div
          key={`${index}:${block.length}`}
          className={
            index < props.blocks.length - 1
              ? "mb-3 whitespace-pre-wrap"
              : "whitespace-pre-wrap"
          }
        >
          {block}
        </div>
      ))}
    </div>
  );
}

export function MarkdownRenderer(props: {
  className?: string;
  content: string;
  fallbackClassName?: string;
}) {
  const blocks = useMemo(
    () => splitMarkdownBlocks(props.content),
    [props.content],
  );
  return (
    <Suspense
      fallback={
        <PlainMarkdownFallback
          blocks={blocks}
          className={
            props.fallbackClassName ??
            "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
          }
        />
      }
    >
      <div className={props.className}>
        {blocks.map((block, index) => (
          <div
            key={`${index}:${block.length}`}
            className={index < blocks.length - 1 ? "prose-chat-block" : undefined}
          >
            <MemoizedMarkdownBlock content={block} />
          </div>
        ))}
      </div>
    </Suspense>
  );
}
