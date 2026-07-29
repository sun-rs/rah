import { readFileSync } from "node:fs";

export type VisualArtifactTheme = "light" | "dark";

const VISUAL_FRAGMENT_PLACEHOLDER =
  "<!--__INLINE_VISUALIZATION_FRAGMENT__-->";
const VISUAL_RESOURCE_SOURCES = [
  "blob:",
  "data:",
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://esm.sh",
  "https://fonts.bunny.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://unpkg.com",
].join(" ");
const VISUAL_ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${VISUAL_RESOURCE_SOURCES}`,
  `style-src 'unsafe-inline' ${VISUAL_RESOURCE_SOURCES}`,
  `img-src ${VISUAL_RESOURCE_SOURCES}`,
  `font-src ${VISUAL_RESOURCE_SOURCES}`,
  `media-src ${VISUAL_RESOURCE_SOURCES}`,
  "worker-src blob:",
  "connect-src blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/*
 * These two assets are vendored byte-for-byte from the Codex Visualize host
 * kit. Keeping them outside this TypeScript module makes provenance explicit
 * and prevents RAH from drifting into a merely similar visual language.
 */
const VISUALIZE_STYLESHEET = readFileSync(
  new URL("./visualize-host/visualize.css", import.meta.url),
  "utf8",
);
const VISUALIZE_HOST_KIT = readFileSync(
  new URL("./visualize-host/visualize.html", import.meta.url),
  "utf8",
);

const VISUAL_ARTIFACT_OPENAI_BRIDGE = String.raw`
(() => {
  const sendFollowUpMessage = (request = {}) => {
    const prompt =
      request != null && typeof request === "object"
        ? String(request.prompt ?? "")
        : "";
    const title =
      request != null &&
      typeof request === "object" &&
      typeof request.title === "string"
        ? request.title
        : undefined;
    parent.postMessage(
      {
        type: "rah.visual.follow-up",
        request: { prompt, ...(title ? { title } : {}) },
      },
      "*",
    );
    return Promise.resolve();
  };

  Object.defineProperty(window, "openai", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({ sendFollowUpMessage }),
  });
})();
`;

const VISUAL_ARTIFACT_SIZE_BRIDGE = String.raw`
(() => {
  let lastHeight = -1;
  let frame = 0;

  const postHeight = () => {
    frame = 0;
    const root = document.documentElement;
    const body = document.body;
    const height = Math.ceil(
      Math.max(
        root?.scrollHeight ?? 0,
        body?.scrollHeight ?? 0,
        body?.offsetHeight ?? 0,
      ),
    );
    if (height === lastHeight) {
      return;
    }
    lastHeight = height;
    parent.postMessage({ type: "rah.visual.resize", height }, "*");
  };

  const scheduleHeight = () => {
    if (frame !== 0) {
      return;
    }
    frame = requestAnimationFrame(() => {
      requestAnimationFrame(postHeight);
    });
  };

  window.addEventListener("load", scheduleHeight, { once: true });
  window.addEventListener("resize", scheduleHeight);
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(scheduleHeight).observe(document.documentElement);
  }
  if (typeof MutationObserver === "function") {
    new MutationObserver(scheduleHeight).observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }
  if (document.fonts?.ready) {
    document.fonts.ready.then(scheduleHeight, () => {});
  }
  scheduleHeight();
})();
`;

export function visualArtifactContentSecurityPolicy(): string {
  return VISUAL_ARTIFACT_CSP;
}

export function buildVisualArtifactDocument(args: {
  fragment: string;
  theme: VisualArtifactTheme;
}): string {
  const hostedFragment = VISUALIZE_HOST_KIT.replace(
    VISUAL_FRAGMENT_PLACEHOLDER,
    args.fragment,
  );
  return `<!doctype html>
<html lang="en" data-theme="${args.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${VISUAL_ARTIFACT_CSP}">
<style>${VISUALIZE_STYLESHEET}
html > body { padding: 0; }
</style>
<script>${VISUAL_ARTIFACT_OPENAI_BRIDGE}</script>
</head>
<body>
${hostedFragment}
<script>${VISUAL_ARTIFACT_SIZE_BRIDGE}</script>
</body>
</html>`;
}
