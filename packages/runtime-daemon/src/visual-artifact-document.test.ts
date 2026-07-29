import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisualArtifactDocument,
  visualArtifactContentSecurityPolicy,
} from "./visual-artifact-document";

test("hosts provider fragments inside the vendored Codex Visualize surface", () => {
  const document = buildVisualArtifactDocument({
    fragment: '<main id="provider-visual">Interactive chart</main>',
    theme: "dark",
  });

  assert.match(document, /^<!doctype html>/);
  assert.match(document, /<html lang="en" data-theme="dark">/);
  assert.match(document, /--font-weight-normal:\s*430/);
  assert.match(document, /id="provider-visual"/);
  assert.match(document, /@floating-ui\/core@1\.7\.3/);
  assert.match(document, /lucide@1\.17\.0/);
  assert.match(document, /rah\.visual\.resize/);
  assert.match(document, /rah\.visual\.follow-up/);
  assert.doesNotMatch(document, /__INLINE_VISUALIZATION_FRAGMENT__/);
});

test("uses a restrictive document policy while allowing the official host resources", () => {
  const policy = visualArtifactContentSecurityPolicy();

  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.match(policy, /https:\/\/unpkg\.com/);
  assert.doesNotMatch(policy, /connect-src[^;]*https:/);
});
