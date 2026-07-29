import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { CodexStoredHistoryAdapter } from "./codex-stored-history-adapter";

const PROVIDER_SESSION_ID = "019f7d82-3eaa-7093-8d75-27a51b60e2cf";
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

function createFixture() {
  const temporaryHome = mkdtempSync(
    path.join(os.tmpdir(), "rah-codex-visual-artifact-"),
  );
  const storageRoot = path.join(temporaryHome, ".codex");
  const rolloutPath = path.join(
    storageRoot,
    "sessions",
    "2026",
    "07",
    "20",
    `rollout-2026-07-20T10-11-12-${PROVIDER_SESSION_ID}.jsonl`,
  );
  const artifactDirectory = path.join(
    storageRoot,
    "visualizations",
    "2026",
    "07",
    "20",
    PROVIDER_SESSION_ID,
  );
  mkdirSync(path.dirname(rolloutPath), { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(rolloutPath, "");

  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const runtimeSessionId = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: PROVIDER_SESSION_ID,
    launchSource: "web",
    cwd: temporaryHome,
    rootDir: temporaryHome,
  }).session.id;
  const adapter = new CodexStoredHistoryAdapter(services);
  adapter.hydrateStoredSessionsCatalog([
    {
      ref: {
        provider: "codex",
        providerSessionId: PROVIDER_SESSION_ID,
      },
      storagePath: rolloutPath,
      archived: false,
    },
  ]);

  return {
    temporaryHome,
    artifactDirectory,
    runtimeSessionId,
    adapter,
  };
}

test("reads only ordinary bounded artifacts from the provider-owned task directory", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      path.join(fixture.artifactDirectory, "equity-curve.html"),
      '<svg id="curve"></svg>',
    );

    assert.deepEqual(
      await fixture.adapter.getSessionConversationVisualArtifact(
        fixture.runtimeSessionId,
        "equity-curve.html",
      ),
      {
        id: "equity-curve.html",
        format: "interactive_html",
        mimeType: "text/html",
        fragment: '<svg id="curve"></svg>',
      },
    );
    assert.equal(
      await fixture.adapter.getSessionConversationVisualArtifact(
        fixture.runtimeSessionId,
        "../equity-curve.html",
      ),
      undefined,
    );
  } finally {
    rmSync(fixture.temporaryHome, { recursive: true, force: true });
  }
});

test("rejects oversized artifacts and symbolic links below the visualization root", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      path.join(fixture.artifactDirectory, "oversized.html"),
      Buffer.alloc(MAX_ARTIFACT_BYTES + 1),
    );
    const outsidePath = path.join(fixture.temporaryHome, "outside.html");
    writeFileSync(outsidePath, "outside");
    symlinkSync(
      outsidePath,
      path.join(fixture.artifactDirectory, "linked.html"),
    );

    assert.equal(
      await fixture.adapter.getSessionConversationVisualArtifact(
        fixture.runtimeSessionId,
        "oversized.html",
      ),
      undefined,
    );
    assert.equal(
      await fixture.adapter.getSessionConversationVisualArtifact(
        fixture.runtimeSessionId,
        "linked.html",
      ),
      undefined,
    );
  } finally {
    rmSync(fixture.temporaryHome, { recursive: true, force: true });
  }
});

test("rejects artifacts reached through a symbolic-link parent directory", async () => {
  const fixture = createFixture();
  try {
    const outsideDirectory = path.join(
      fixture.temporaryHome,
      "outside-visualization-task",
    );
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(
      path.join(outsideDirectory, "parent-linked.html"),
      "<main>outside</main>",
    );
    rmSync(fixture.artifactDirectory, { recursive: true, force: true });
    symlinkSync(outsideDirectory, fixture.artifactDirectory);

    assert.equal(
      await fixture.adapter.getSessionConversationVisualArtifact(
        fixture.runtimeSessionId,
        "parent-linked.html",
      ),
      undefined,
    );
  } finally {
    rmSync(fixture.temporaryHome, { recursive: true, force: true });
  }
});
