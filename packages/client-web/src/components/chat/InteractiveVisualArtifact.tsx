import type { TimelineVisualArtifact } from "@rah/runtime-protocol";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readSessionConversationVisualArtifactDocument } from "../../api";
import { useTheme } from "../../hooks/useTheme";

const INITIAL_VISUAL_HEIGHT_PX = 240;
const MIN_VISUAL_HEIGHT_PX = 120;
const MAX_VISUAL_HEIGHT_PX = 2_400;

function boundedVisualHeight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(
    MIN_VISUAL_HEIGHT_PX,
    Math.min(MAX_VISUAL_HEIGHT_PX, Math.ceil(value)),
  );
}

export function InteractiveVisualArtifact(props: {
  sessionId: string;
  artifact: TimelineVisualArtifact;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { colorScheme } = useTheme();
  const [documentHtml, setDocumentHtml] = useState<string>();
  const [error, setError] = useState<string>();
  const [height, setHeight] = useState(INITIAL_VISUAL_HEIGHT_PX);

  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setDocumentHtml(undefined);
    setHeight(INITIAL_VISUAL_HEIGHT_PX);
    void readSessionConversationVisualArtifactDocument(
      props.sessionId,
      props.artifact.id,
      {
        theme: colorScheme,
        signal: controller.signal,
      },
    )
      .then((html) => {
        if (!controller.signal.aborted) {
          setDocumentHtml(html);
        }
      })
      .catch((requestError: unknown) => {
        if (
          !controller.signal.aborted &&
          !(requestError instanceof DOMException && requestError.name === "AbortError")
        ) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "The visual could not be loaded.",
          );
        }
      });
    return () => controller.abort();
  }, [colorScheme, props.artifact.id, props.sessionId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data =
        event.data && typeof event.data === "object"
          ? (event.data as { type?: unknown; height?: unknown })
          : undefined;
      if (data?.type !== "rah.visual.resize") {
        return;
      }
      const nextHeight = boundedVisualHeight(data.height);
      if (nextHeight !== undefined) {
        setHeight(nextHeight);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  if (error) {
    return (
      <div
        className="flex min-h-20 w-full items-center gap-2 px-1 py-3 text-sm text-[var(--app-hint)]"
        data-testid="interactive-visual-error"
        title={error}
      >
        <AlertCircle size={16} aria-hidden="true" />
        <span>This visual is no longer available.</span>
      </div>
    );
  }

  if (!documentHtml) {
    return (
      <div
        className="flex w-full items-center justify-center text-[var(--app-hint)]"
        style={{ height: INITIAL_VISUAL_HEIGHT_PX }}
        data-testid="interactive-visual-loading"
      >
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
        <span className="sr-only">Loading interactive visual</span>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={props.artifact.label ?? "Interactive visual"}
      srcDoc={documentHtml}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block w-full border-0 bg-transparent"
      style={{ height }}
      data-testid="interactive-visual-artifact"
    />
  );
}
