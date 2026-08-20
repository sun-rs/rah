import type { TimelineVisualArtifact } from "@rah/runtime-protocol";
import { AlertCircle, FileCode2, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  readSessionConversationVisualArtifactDocument,
  readSessionConversationVisualArtifactSource,
} from "../../api";
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

export function InteractiveVisualArtifactError(props: {
  artifact: TimelineVisualArtifact;
  error: string;
  onOpenLocalFile?: (path: string) => void;
  sourcePath: string | null | undefined;
}) {
  return (
    <div
      className="flex min-h-20 w-full items-start gap-2 px-1 py-3 text-sm text-[var(--app-hint)]"
      data-testid="interactive-visual-error"
      title={props.error}
    >
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <div>Interactive visual could not be displayed.</div>
        {props.sourcePath && props.onOpenLocalFile ? (
          <button
            type="button"
            className="mt-1 inline-flex max-w-full items-center gap-1 text-left text-[var(--app-link)] underline decoration-current/35 underline-offset-2 outline-none hover:decoration-current focus-visible:decoration-current"
            title={props.sourcePath}
            onClick={() => {
              if (props.sourcePath) {
                props.onOpenLocalFile?.(props.sourcePath);
              }
            }}
          >
            <FileCode2 size={14} className="shrink-0" aria-hidden="true" />
            <span className="truncate">
              {props.artifact.label ?? props.artifact.id}
            </span>
          </button>
        ) : props.sourcePath === null ? (
          <div className="mt-1 truncate text-xs" title={props.artifact.id}>
            HTML source not found: {props.artifact.id}
          </div>
        ) : (
          <div className="mt-1 text-xs">Locating HTML source…</div>
        )}
      </div>
    </div>
  );
}

export function InteractiveVisualArtifact(props: {
  sessionId: string;
  artifact: TimelineVisualArtifact;
  onOpenLocalFile?: (path: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { colorScheme } = useTheme();
  const [documentHtml, setDocumentHtml] = useState<string>();
  const [error, setError] = useState<string>();
  const [sourcePath, setSourcePath] = useState<string | null>();
  const [height, setHeight] = useState(INITIAL_VISUAL_HEIGHT_PX);

  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setDocumentHtml(undefined);
    setSourcePath(undefined);
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
          void readSessionConversationVisualArtifactSource(
            props.sessionId,
            props.artifact.id,
            { signal: controller.signal },
          )
            .then((source) => {
              if (!controller.signal.aborted) {
                setSourcePath(source.path);
              }
            })
            .catch((sourceError: unknown) => {
              if (
                !controller.signal.aborted &&
                !(sourceError instanceof DOMException && sourceError.name === "AbortError")
              ) {
                setSourcePath(null);
              }
            });
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
      <InteractiveVisualArtifactError
        artifact={props.artifact}
        error={error}
        sourcePath={sourcePath}
        {...(props.onOpenLocalFile
          ? { onOpenLocalFile: props.onOpenLocalFile }
          : {})}
      />
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
