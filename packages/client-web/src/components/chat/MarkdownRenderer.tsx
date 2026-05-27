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
import { importWithStaleReload } from "../../lazy-module-reload";
import { splitMarkdownBlocks } from "./markdown-blocks";
import { resolveLocalFileLinkPath } from "./local-file-link";

const ReactMarkdown = lazy(async () => ({
  default: (await importWithStaleReload(() => import("react-markdown"))).default,
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

function createMarkdownComponents(
  onOpenLocalFile: ((path: string) => void) | undefined,
): Components {
  return {
    a({ node: _node, href, children, ...anchorProps }) {
      const localFilePath = resolveLocalFileLinkPath(href);
      if (localFilePath) {
        if (!onOpenLocalFile) {
          return (
            <span title={localFilePath} className="text-[var(--app-fg)]">
              {children}
            </span>
          );
        }
        return (
          <button
            type="button"
            className="inline cursor-pointer border-0 bg-transparent p-0 text-left text-[var(--app-link)] underline underline-offset-2 hover:opacity-80"
            title={`Open in Inspector: ${localFilePath}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenLocalFile(localFilePath);
            }}
          >
            {children}
          </button>
        );
      }
      return <a {...anchorProps} href={href} target="_blank" rel="noreferrer" />;
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
}

const remarkPlugins = [remarkGfm, remarkBreaks];

const MemoizedMarkdownBlock = memo(function MemoizedMarkdownBlock(props: {
  content: string;
  components: Components;
}) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={props.components}>
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
  onOpenLocalFile?: (path: string) => void;
}) {
  const blocks = useMemo(
    () => splitMarkdownBlocks(props.content),
    [props.content],
  );
  const components = useMemo(
    () => createMarkdownComponents(props.onOpenLocalFile),
    [props.onOpenLocalFile],
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
            <MemoizedMarkdownBlock content={block} components={components} />
          </div>
        ))}
      </div>
    </Suspense>
  );
}
