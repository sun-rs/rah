import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GlobalWorkbenchNoticeHost,
  resolveGlobalWorkbenchCalloutPlacement,
  type GlobalWorkbenchNotice,
} from "./GlobalWorkbenchCallout";

test("anchors wide browser notices to the desktop corner", () => {
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("wide", false), "desktop-corner");
});

test("centers compact, medium, and PWA notices", () => {
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("compact", false), "centered");
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("medium", false), "centered");
  assert.equal(resolveGlobalWorkbenchCalloutPlacement("wide", true), "centered");
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
  assert.ok(markup.indexOf("Restart required") < markup.indexOf("Action failed"));
  assert.match(markup, /flex flex-col gap-2/);
});
