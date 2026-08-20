import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GlobalWorkbenchCallout,
  GlobalWorkbenchNoticeHost,
  resolveGlobalWorkbenchCalloutPlacement,
  type GlobalWorkbenchNotice,
} from "./GlobalWorkbenchCallout";
import {
  WORKBENCH_HEADER_LAYOUT,
  pwaWorkbenchNoticeTop,
} from "../workbench-header-contract";

test("anchors wide browser notices to the desktop corner", () => {
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("wide", false), "desktop-corner");
});

test("centers narrow browser notices and moves PWA notices below the safe-area header", () => {
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("compact", false), "centered");
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("medium", false), "centered");
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("wide", true), "pwa-top");
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("compact", true), "pwa-top");
});

test("renders PWA compatibility recovery as one compact row", () => {
  const source = readFileSync(
    new URL("./GlobalWorkbenchCallout.tsx", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");
  const markup = renderToStaticMarkup(
    createElement(GlobalWorkbenchCallout, {
      compact: true,
      id: "runtime-compatibility",
      errorDescriptor: {
        title: "Restart RAH to update",
        body: "Restart it on the host, then refresh this page.",
      },
      selectedSummary: null,
      onRefresh: () => undefined,
      onClaimControl: () => undefined,
      onDismiss: () => undefined,
      dismissLabel: "Mute today",
    }),
  );

  assert.match(markup, /data-workbench-callout-variant="pwa-compact"/);
  assert.match(markup, /rah-recovery-notice/);
  assert.doesNotMatch(markup, /shadow-|backdrop-blur|border-\[var\(--app-warning\)\]|bg-\[var\(--app-warning-bg\)\]/);
  assert.match(styles, /\.rah-recovery-notice\s*\{/);
  assert.match(styles, /--rah-recovery-orange:\s*#f97316/);
  assert.match(styles, /var\(--rah-recovery-orange\) 18%, var\(--app-border\)/);
  assert.match(styles, /var\(--rah-recovery-orange\) 8%, var\(--app-bg\)/);
  assert.match(styles, /var\(--rah-recovery-orange\) 82%, var\(--app-fg\)/);
  assert.match(styles, /box-shadow: none/);
  assert.match(source, /pwaTop\s*\? "p-1"/);
  assert.match(markup, /hidden line-clamp-2[^\"]*sm:block/);
  assert.match(markup, /whitespace-nowrap/);
  assert.match(markup, /Restart RAH to update/);
  assert.match(markup, /Restart it on the host, then refresh this page\./);
  assert.doesNotMatch(markup, />Retry</);
  assert.match(markup, />Mute today</);
  assert.match(markup, /aria-label="Mute today"/);
});

test("anchors PWA recovery below the single workbench header contract", () => {
  const headerSource = readFileSync(
    new URL("../shells/ConversationHeader.tsx", import.meta.url),
    "utf8",
  );
  const canvasSource = readFileSync(
    new URL("../canvas/CanvasWorkbench.tsx", import.meta.url),
    "utf8",
  );
  const calloutSource = readFileSync(
    new URL("./GlobalWorkbenchCallout.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(WORKBENCH_HEADER_LAYOUT.heightClassName, "h-10");
  assert.equal(WORKBENCH_HEADER_LAYOUT.heightCssValue, "2.5rem");
  assert.equal(WORKBENCH_HEADER_LAYOUT.heightPx, 40);
  assert.equal(
    pwaWorkbenchNoticeTop(),
    "calc(env(safe-area-inset-top, 0px) + 2.5rem)",
  );
  assert.match(headerSource, /WORKBENCH_HEADER_LAYOUT\.heightClassName/);
  assert.match(headerSource, /data-workbench-header=""/);
  assert.match(canvasSource, /<ConversationHeader/);
  assert.doesNotMatch(canvasSource, /data-workbench-header=""/);
  assert.match(calloutSource, /top:\s*pwaWorkbenchNoticeTop\(\)/);
  assert.doesNotMatch(headerSource, /presentation === "page" \? "h-14" : "h-12"/);
  assert.doesNotMatch(canvasSource, /className="flex h-14/);
});

test("renders desktop corner recovery as a small inline toast", () => {
  const markup = renderToStaticMarkup(
    createElement(GlobalWorkbenchCallout, {
      cornerCompact: true,
      id: "runtime-compatibility",
      errorDescriptor: {
        title: "Restart RAH to update",
        body: "Restart it on the host, then refresh this page.",
      },
      selectedSummary: null,
      onRefresh: () => undefined,
      onClaimControl: () => undefined,
      onDismiss: () => undefined,
      dismissLabel: "Mute today",
    }),
  );

  assert.match(markup, /data-workbench-callout-variant="desktop-compact"/);
  assert.match(markup, /rah-recovery-notice/);
  assert.doesNotMatch(markup, /shadow-|backdrop-blur|bg-primary|text-primary-foreground/);
  assert.match(markup, /Restart RAH to update/);
  assert.match(markup, /Restart it on the host, then refresh this page\./);
  assert.doesNotMatch(markup, />Retry</);
  assert.match(markup, />Mute today</);
  assert.match(markup, /aria-label="Mute today"/);
});

test("keeps simultaneous global notices in one upward-growing host", () => {
  const notice = (id: string, title: string): GlobalWorkbenchNotice => ({
    id,
    errorDescriptor: {
      title,
      body: `${title} details`,
    },
    selectedSummary: null,
    onRefresh: () => undefined,
    onClaimControl: () => undefined,
    onDismiss: () => undefined,
  });
  const markup = renderToStaticMarkup(
    createElement(GlobalWorkbenchNoticeHost, {
      notices: [
        notice("runtime-compatibility", "Restart required"),
        notice("workbench-error", "Action failed"),
      ],
      viewportTier: "wide",
    }),
  );

  assert.match(markup, /data-workbench-notice-host=""/);
  assert.match(markup, /data-placement="desktop-corner"/);
  assert.match(markup, /data-workbench-callout-variant="desktop-compact"/);
  assert.ok(markup.indexOf("Restart required") < markup.indexOf("Action failed"));
  assert.match(markup, /flex flex-col gap-2/);
  assert.match(markup, /right-4/);
  assert.match(markup, /w-\[min\(24rem,calc\(100vw-2rem\)\)\]/);
  assert.match(markup, /bottom:max\(1rem, env\(safe-area-inset-bottom, 0px\)\)/);
  assert.doesNotMatch(markup, /workbench-callout-anchor/);
});
