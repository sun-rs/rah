import {
  Check,
  Copy,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { copyTextToClipboard } from "../../clipboard";
import { useTheme } from "../../hooks/useTheme";

let mermaidRenderQueue: Promise<void> = Promise.resolve();

async function renderMermaid(
  id: string,
  code: string,
  colorScheme: "light" | "dark",
): Promise<string> {
  let svg = "";
  const render = async () => {
    // Use Mermaid's self-contained browser build so its sizeable diagram
    // engine graph can stay behind this dynamic import instead of leaking
    // transitive packages into the application's eager vendor chunk.
    const mermaid = (await import("mermaid/dist/mermaid.esm.min.mjs")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: colorScheme === "dark" ? "dark" : "neutral",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", sans-serif',
      flowchart: {
        htmlLabels: true,
        useMaxWidth: true,
      },
    });
    svg = (await mermaid.render(id, code)).svg;
  };
  const queued = mermaidRenderQueue.then(render, render);
  mermaidRenderQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  await queued;
  return svg;
}

export function MermaidDiagram(props: { code: string }) {
  const { colorScheme } = useTheme();
  const reactId = useId();
  const renderId = `rah-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    void renderMermaid(renderId, props.code, colorScheme)
      .then((nextSvg) => {
        if (!cancelled) {
          setSvg(nextSvg);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setSvg("");
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to render this Mermaid diagram.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [colorScheme, props.code, renderId]);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const copyCode = async () => {
    if ((await copyTextToClipboard(props.code)) === "copied") {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    }
  };

  return (
    <div
      className={`prose-chat-mermaid${expanded ? " prose-chat-mermaid-expanded" : ""}`}
      data-testid="mermaid-diagram"
    >
      <div className="prose-chat-mermaid-toolbar">
        <span>mermaid</span>
        <div>
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            title={expanded ? "Exit full screen" : "View full screen"}
            aria-label={expanded ? "Exit full screen" : "View full screen"}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            onClick={() => void copyCode()}
            title="Copy diagram source"
            aria-label="Copy diagram source"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      <div className="prose-chat-mermaid-canvas">
        {svg ? (
          <div
            className="prose-chat-mermaid-svg"
            role="img"
            aria-label="Mermaid diagram"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error ? (
          <div className="prose-chat-mermaid-error">
            <div>{error}</div>
            <pre>
              <code>{props.code}</code>
            </pre>
          </div>
        ) : (
          <div className="prose-chat-mermaid-loading" aria-label="Rendering diagram" />
        )}
      </div>
    </div>
  );
}
