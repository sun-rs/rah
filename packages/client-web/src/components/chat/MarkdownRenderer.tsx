import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { copyTextToClipboard } from "../../clipboard";
import { useTheme } from "../../hooks/useTheme";
import {
  ensureHighlighterLanguage,
  extractHighlightedCodeHtml,
  getHighlighter,
  highlight,
  normalizeShikiLanguage,
} from "../../lib/shiki";
import { splitMarkdownBlocks } from "./markdown-blocks";
import { resolveLocalFileLinkPath } from "./local-file-link";
import { FileResourceIcon } from "./FileResourceIcon";
import { LocalImageResource } from "./LocalImageResource";
import { MermaidDiagram } from "./MermaidDiagram";
import { codexShikiThemeForColorScheme } from "../../lib/codex-shiki-themes";

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

type SelectionLike = Pick<Selection, "isCollapsed" | "rangeCount" | "getRangeAt">;

export function selectionIntersectsNode(
  selection: SelectionLike | null,
  node: Node,
): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(node)) {
        return true;
      }
    } catch {
      // A stale browser range must not block normal file opening.
    }
  }
  return false;
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

const MARKDOWN_IMAGE_LINE_PATTERN =
  /^\s*!\[[^\]\n]*\]\(\s*(?:<[^>\n]+>|(?:\\.|[^\\)\n])*)\s*(?:(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?\s*\)\s*$/;

export function isImageOnlyMarkdownBlock(block: string): boolean {
  const lines = block
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return (
    lines.length > 0 &&
    lines.every((line) => MARKDOWN_IMAGE_LINE_PATTERN.test(line))
  );
}

export function coalesceMarkdownImageBlocks(blocks: string[]): string[] {
  const coalesced: string[] = [];
  for (const block of blocks) {
    if (
      isImageOnlyMarkdownBlock(block) &&
      coalesced.length > 0 &&
      isImageOnlyMarkdownBlock(coalesced[coalesced.length - 1] ?? "")
    ) {
      coalesced[coalesced.length - 1] = `${coalesced[coalesced.length - 1]}\n${block}`;
      continue;
    }
    coalesced.push(block);
  }
  return coalesced;
}

function imageOnlyChildren(children: ReactNode, imageComponent: unknown) {
  const candidates = Children.toArray(children).filter(
    (child) =>
      !(typeof child === "string" && child.trim().length === 0) &&
      !(isValidElement(child) && child.type === "br"),
  );
  if (candidates.length === 0) {
    return null;
  }
  for (const candidate of candidates) {
    if (!isValidElement(candidate) || candidate.type !== imageComponent) {
      return null;
    }
  }
  return candidates;
}

function useHighlightedCodeHtml(code: string, language: string | null): string | null {
  const { colorScheme } = useTheme();
  const normalizedLanguage = normalizeShikiLanguage(language);
  const renderKey = `${colorScheme}:${normalizedLanguage ?? "plain"}:${code}`;
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null);

  useEffect(() => {
    if (!normalizedLanguage) {
      setHighlighted(null);
      return;
    }
    let cancelled = false;
    void getHighlighter()
      .then(() => ensureHighlighterLanguage(normalizedLanguage))
      .then((loaded) => {
        if (!loaded || cancelled) return;
        const rendered = highlight(
          code,
          normalizedLanguage,
          codexShikiThemeForColorScheme(colorScheme),
        );
        const html = extractHighlightedCodeHtml(rendered);
        if (!cancelled && html !== null) {
          setHighlighted({ key: renderKey, html });
        }
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, colorScheme, normalizedLanguage, renderKey]);

  return highlighted?.key === renderKey ? highlighted.html : null;
}

function MarkdownPre({
  children,
  node: _node,
  ...preProps
}: ComponentPropsWithoutRef<"pre"> & MarkdownExtraProps) {
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => textFromNode(children), [children]);
  const language = useMemo(() => languageFromNode(children), [children]);
  const normalizedLanguage = useMemo(() => normalizeShikiLanguage(language), [language]);
  const highlightedHtml = useHighlightedCodeHtml(code, language);

  const copyCode = async () => {
    if (!code) {
      return;
    }
    if ((await copyTextToClipboard(code)) === "copied") {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };
  const showHeader = language !== null && language !== "text" && language !== "plain";

  if (language?.toLowerCase() === "mermaid") {
    return <MermaidDiagram code={code.trimEnd()} />;
  }

  return (
    <div className={`prose-chat-codeblock${showHeader ? "" : " prose-chat-codeblock-plain"}`}>
      {showHeader ? (
        <div className="prose-chat-codeblock-header">
          <span>{language}</span>
          <button type="button" onClick={() => void copyCode()} title="Copy code">
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="prose-chat-codeblock-copy"
          onClick={() => void copyCode()}
          title="Copy code"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
      <pre {...preProps} data-syntax-highlighted={highlightedHtml !== null ? "true" : undefined}>
        {highlightedHtml !== null ? (
          <code
            className={normalizedLanguage ? `language-${normalizedLanguage}` : undefined}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          children
        )}
      </pre>
    </div>
  );
}

export function createMarkdownComponents(
  onOpenLocalFile: ((path: string) => void) | undefined,
): Components {
  const MarkdownImage: NonNullable<Components["img"]> = ({
    node: _node,
    src,
    alt,
  }) => {
    const imageSource = typeof src === "string" ? src : undefined;
    const localFilePath = resolveLocalFileLinkPath(imageSource);
    return (
      <LocalImageResource
        mode="inline"
        {...(localFilePath ? { path: localFilePath } : {})}
        {...(!localFilePath && imageSource ? { url: imageSource } : {})}
        {...(alt ? { alt } : {})}
        {...(onOpenLocalFile ? { onOpenLocalFile } : {})}
      />
    );
  };

  return {
    img: MarkdownImage,
    p({ node: _node, children, className, ...paragraphProps }) {
      const images = imageOnlyChildren(children, MarkdownImage);
      if (images) {
        const isGrid = images.length > 1;
        return (
          <p
            {...paragraphProps}
            className={`prose-chat-media-paragraph${
              isGrid ? " prose-chat-media-grid" : ""
            }${className ? ` ${className}` : ""}`}
            data-markdown-image-grid={isGrid ? "true" : undefined}
          >
            {children}
          </p>
        );
      }
      return (
        <p {...paragraphProps} className={className}>
          {children}
        </p>
      );
    },
    a({ node: _node, href, children, ...anchorProps }) {
      const localFilePath = resolveLocalFileLinkPath(href);
      if (localFilePath) {
        if (!onOpenLocalFile) {
          return (
            <span title={localFilePath} className="text-[var(--app-fg)]">
              <span className="prose-chat-local-file-content">
                <FileResourceIcon
                  path={localFilePath}
                  className="shrink-0"
                  tone="inherit"
                />
                <span>{children}</span>
              </span>
            </span>
          );
        }
        return (
          <button
            type="button"
            className="prose-chat-local-file-link"
            data-selectable-conversation-text="true"
            title={`Open in Inspector: ${localFilePath}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (
                event.detail > 0 &&
                selectionIntersectsNode(window.getSelection(), event.currentTarget)
              ) {
                return;
              }
              onOpenLocalFile(localFilePath);
            }}
          >
            <span className="prose-chat-local-file-content">
              <FileResourceIcon
                path={localFilePath}
                className="shrink-0"
                tone="inherit"
              />
              <span>{children}</span>
            </span>
          </button>
        );
      }
      return (
        <a {...anchorProps} href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    code({ node: _node, children, ...codeProps }) {
      const codeText = textFromNode(children);
      const trimmedCodeText = codeText.trim();
      const localFilePath =
        codeText === trimmedCodeText
          ? resolveLocalFileLinkPath(trimmedCodeText)
          : null;
      if (localFilePath) {
        if (!onOpenLocalFile) {
          return (
            <code {...codeProps} title={localFilePath}>
              {children}
            </code>
          );
        }
        return (
          <button
            type="button"
            className="prose-chat-local-file-code"
            data-selectable-conversation-text="true"
            title={`Open in Inspector: ${localFilePath}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (
                event.detail > 0 &&
                selectionIntersectsNode(window.getSelection(), event.currentTarget)
              ) {
                return;
              }
              onOpenLocalFile(localFilePath);
            }}
          >
            <span className="prose-chat-local-file-content">
              <FileResourceIcon
                path={localFilePath}
                className="shrink-0"
                tone="inherit"
              />
              <code {...codeProps}>{children}</code>
            </span>
          </button>
        );
      }
      return <code {...codeProps}>{children}</code>;
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

export function MarkdownRenderer(props: {
  className?: string;
  content: string;
  onOpenLocalFile?: (path: string) => void;
}) {
  const blocks = useMemo(
    () => coalesceMarkdownImageBlocks(splitMarkdownBlocks(props.content)),
    [props.content],
  );
  const components = useMemo(
    () => createMarkdownComponents(props.onOpenLocalFile),
    [props.onOpenLocalFile],
  );
  return (
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
  );
}
