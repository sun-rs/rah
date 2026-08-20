const HTML_PREVIEW_CSP_DIRECTIVES = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

function createPreviewNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function escapeInlineScriptString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function buildIsolatedHtmlPreviewDocument(
  source: string,
  options: { nonce?: string } = {},
): string {
  const nonce = options.nonce ?? createPreviewNonce();
  const contentSecurityPolicy = [
    ...HTML_PREVIEW_CSP_DIRECTIVES,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const sourceLiteral = escapeInlineScriptString(source);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
<style>
html, body { min-height: 100%; }
body { margin: 0; }
</style>
</head>
<body>
<script nonce="${nonce}">
(() => {
  const source = ${sourceLiteral};
  const parsed = new DOMParser().parseFromString(source, "text/html");
  const blockedElements = parsed.querySelectorAll(
    "script, iframe, frame, frameset, object, embed, base, link, meta[http-equiv]",
  );
  blockedElements.forEach((element) => element.remove());

  const urlAttributes = new Set(["href", "xlink:href", "action", "formaction"]);
  const sourceAttributes = new Set(["src", "poster"]);
  const isAllowedDataSource = (value) => {
    const normalized = value.toLowerCase();
    return (
      normalized.startsWith("data:image/") ||
      normalized.startsWith("data:audio/") ||
      normalized.startsWith("data:video/")
    );
  };
  parsed.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "srcset" ||
        name === "autofocus" ||
        name === "target"
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (urlAttributes.has(name)) {
        if ((name === "href" || name === "xlink:href") && value.startsWith("#")) {
          continue;
        }
        element.removeAttribute(attribute.name);
        continue;
      }
      if (sourceAttributes.has(name) && !isAllowedDataSource(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  const copyAttributes = (from, to) => {
    for (const attribute of [...from.attributes]) {
      to.setAttribute(attribute.name, attribute.value);
    }
  };
  copyAttributes(parsed.documentElement, document.documentElement);
  copyAttributes(parsed.body, document.body);
  document.title = parsed.title;
  for (const style of parsed.head.querySelectorAll("style")) {
    document.head.append(document.importNode(style, true));
  }
  document.body.replaceChildren(
    ...[...parsed.body.childNodes].map((node) => document.importNode(node, true)),
  );
  document.documentElement.dataset.rahHtmlPreviewReady = "true";
})();
</script>
</body>
</html>`;
}
