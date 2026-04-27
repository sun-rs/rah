import { describe, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderModelCatalog, SessionSummary } from "@rah/runtime-protocol";
import { SessionCapabilitySection } from "./SessionCapabilitySection";

function codexCatalog(): ProviderModelCatalog {
  return {
    provider: "codex",
    currentModelId: "gpt-beta",
    fetchedAt: "2026-04-27T00:00:00.000Z",
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    modelsExact: true,
    optionsExact: true,
    models: [
      { id: "gpt-alpha", label: "GPT Alpha", defaultReasoningId: "high" },
      { id: "gpt-beta", label: "GPT Beta", defaultReasoningId: "low" },
    ],
    modelProfiles: [
      {
        modelId: "gpt-beta",
        source: "native_online",
        freshness: "authoritative",
        configOptions: [
          {
            id: "model_reasoning_effort",
            label: "Reasoning effort",
            kind: "select",
            scope: "model",
            source: "native_online",
            mutable: true,
            applyTiming: "next_turn",
            options: [{ id: "low", label: "Low" }],
          },
        ],
      },
    ],
  };
}

function codexSummary(): SessionSummary {
  return {
    session: {
      id: "session-codex-ui",
      provider: "codex",
      launchSource: "web",
      cwd: "/workspace",
      rootDir: "/workspace",
      runtimeState: "idle",
      ptyId: "pty-codex-ui",
      title: "Codex Session",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        renameSession: true,
        actions: {
          info: true,
          archive: true,
          delete: true,
          rename: "native",
        },
        steerInput: true,
        queuedInput: false,
        modelSwitch: true,
        planMode: false,
        subagents: false,
      },
      model: {
        currentModelId: "gpt-beta",
        currentReasoningId: "low",
        availableModels: codexCatalog().models,
        mutable: true,
        source: "native",
      },
      modelProfile: codexCatalog().modelProfiles?.[0],
      config: {
        values: {
          model_reasoning_effort: "low",
        },
        source: "runtime_session",
      },
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    },
    attachedClients: [],
    controlLease: { sessionId: "session-codex-ui" },
  };
}

describe("SessionCapabilitySection", () => {
  test("renders runtime-confirmed Codex capability summary", () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionCapabilitySection, {
        catalog: codexCatalog(),
        summary: codexSummary(),
        selectedModelId: "gpt-beta",
      }),
    );

    assert.match(html, /Options/);
    assert.match(html, /Reasoning effort/);
    assert.match(html, /Reasoning effort: low/);
    assert.doesNotMatch(html, /native_online/);
    assert.doesNotMatch(html, /authoritative/);
    assert.doesNotMatch(html, /Advanced config preview/);
  });
});
