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
import { realpath } from "node:fs/promises";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { CodexStoredHistoryAdapter } from "./codex-stored-history-adapter";
import { codexVisualArtifactIdForPath } from "./codex-visual-artifacts";

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
  const workspaceRoot = path.join(temporaryHome, "workspace");
  const workspaceArtifactDirectory = path.join(
    workspaceRoot,
    ".codex",
    "visualizations",
    "2026",
    "07",
    "20",
    PROVIDER_SESSION_ID,
  );
  mkdirSync(path.dirname(rolloutPath), { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(workspaceArtifactDirectory, { recursive: true });
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
    cwd: workspaceRoot,
    rootDir: workspaceRoot,
  }).session.id;
  const adapter = new CodexStoredHistoryAdapter(services);
  adapter.hydrateStoredSessionsCatalog([
    {
      ref: {
        provider: "codex",
        providerSessionId: PROVIDER_SESSION_ID,
        cwd: workspaceRoot,
        rootDir: workspaceRoot,
      },
      storagePath: rolloutPath,
      archived: false,
    },
  ]);

  return {
    temporaryHome,
    artifactDirectory,
    workspaceArtifactDirectory,
    runtimeSessionId,
    adapter,
  };
}

test("reads workspace-local visuals before the legacy provider storage location", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      path.join(fixture.artifactDirectory, "equity-curve.html"),
      "<main>legacy</main>",
    );
    writeFileSync(
      path.join(fixture.workspaceArtifactDirectory, "equity-curve.html"),
      "<main>workspace</main>",
    );

    assert.equal(
      (
        await fixture.adapter.getSessionConversationVisualArtifact(
          fixture.runtimeSessionId,
          "equity-curve.html",
        )
      )?.fragment,
      "<main>workspace</main>",
    );
  } finally {
    rmSync(fixture.temporaryHome, { recursive: true, force: true });
  }
});

test("reads a provider-evidenced workspace visual from a human-readable directory", async () => {
  const fixture = createFixture();
  try {
    const evidencedDirectory = path.join(
      path.dirname(path.dirname(path.dirname(path.dirname(fixture.workspaceArtifactDirectory)))),
      "2026",
      "08",
      "15",
      "sxx-optimal-combinations",
    );
    mkdirSync(evidencedDirectory, { recursive: true });
    const sourcePath = path.join(
      evidencedDirectory,
      "optimal-candidate-combinations.html",
    );
    writeFileSync(sourcePath, "<main>evidenced</main>");
    const artifactId = codexVisualArtifactIdForPath(
      ".codex/visualizations/2026/08/15/sxx-optimal-combinations/optimal-candidate-combinations.html",
    )!;

    assert.equal(
      (
        await fixture.adapter.getSessionConversationVisualArtifact(
          fixture.runtimeSessionId,
          artifactId,
        )
      )?.fragment,
      "<main>evidenced</main>",
    );
  } finally {
    rmSync(fixture.temporaryHome, { recursive: true, force: true });
  }
});

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

test("exposes only a verified visual source path for file-browser fallback", async () => {
  const fixture = createFixture();
  try {
    const sourcePath = path.join(
      fixture.workspaceArtifactDirectory,
      "equity-curve.html",
    );
    writeFileSync(sourcePath, "<main>workspace</main>");

    const source = await fixture.adapter.getSessionConversationVisualArtifactSource(
      fixture.runtimeSessionId,
      "equity-curve.html",
    );
    assert.equal(source?.id, "equity-curve.html");
    assert.equal(await realpath(source?.path ?? ""), await realpath(sourcePath));
    assert.equal(
      await fixture.adapter.getSessionConversationVisualArtifactSource(
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
