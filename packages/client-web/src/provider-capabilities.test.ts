import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import {
  resolveCapabilityViewOrigin,
  resolveCapabilityViewOriginLabel,
  resolveCapabilityHeadline,
  resolveConfigPreviewOrigin,
  resolveConfigPreviewOriginLabel,
  formatSessionConfigValue,
  resolveActiveModelCapabilityProfile,
  resolveCapabilityCautionText,
  resolveCapabilityExactnessDisplay,
  resolveCapabilityExactnessLabel,
  resolveCapabilityFreshnessLabel,
  resolveCapabilitySourceLabel,
  resolveEffectiveModelId,
  resolveSessionCapabilityFreshnessLabel,
  resolveSessionCapabilitySourceLabel,
  resolveSessionConfigPreviewRows,
  resolveConfigOptionPreviewRows,
  resolveVisibleConfigOptionLabels,
  buildModelOptionValuesFromReasoning,
} from "./provider-capabilities";

function catalog(): ProviderModelCatalog {
  return {
    provider: "codex",
    currentModelId: "gpt-5.5",
    fetchedAt: "2026-04-27T00:00:00.000Z",
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    revision: "abc123",
    modelsExact: true,
    optionsExact: true,
    models: [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        defaultReasoningId: "medium",
      },
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        defaultReasoningId: "high",
      },
    ],
    configOptions: [
      {
        id: "global_toggle",
        label: "Global toggle",
        kind: "boolean",
        scope: "provider",
        source: "native_online",
        mutable: true,
        applyTiming: "immediate",
        currentValue: true,
      },
    ],
    modelProfiles: [
      {
        modelId: "gpt-5.5",
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
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
            ],
          },
        ],
      },
    ],
  };
}

function geminiCatalog(): ProviderModelCatalog {
  return {
    provider: "gemini",
    currentModelId: "auto",
    fetchedAt: "2026-04-27T00:00:00.000Z",
    source: "static",
    sourceDetail: "static_builtin",
    freshness: "provisional",
    modelsExact: false,
    optionsExact: false,
    models: [
      { id: "auto", label: "Auto (Gemini 3)" },
      { id: "auto-gemini-2.5", label: "Auto (Gemini 2.5)" },
      { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview" },
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    ],
    modelProfiles: [
      {
        modelId: "auto",
        source: "static_builtin",
        freshness: "provisional",
        configOptions: [
          {
            id: "thinking_level",
            label: "Thinking level",
            kind: "select",
            scope: "model",
            source: "static_builtin",
            mutable: true,
            applyTiming: "next_turn",
            options: [{ id: "HIGH", label: "HIGH" }],
          },
        ],
      },
      {
        modelId: "auto-gemini-2.5",
        source: "static_builtin",
        freshness: "provisional",
        configOptions: [
          {
            id: "thinking_budget",
            label: "Thinking budget",
            kind: "number",
            scope: "model",
            source: "static_builtin",
            mutable: true,
            applyTiming: "next_turn",
          },
        ],
      },
      {
        modelId: "gemini-3.1-pro-preview",
        source: "static_builtin",
        freshness: "provisional",
        configOptions: [
          {
            id: "thinking_level",
            label: "Thinking level",
            kind: "select",
            scope: "model",
            source: "static_builtin",
            mutable: true,
            applyTiming: "next_turn",
            options: [{ id: "HIGH", label: "HIGH" }],
          },
        ],
      },
      {
        modelId: "gemini-2.5-pro",
        source: "static_builtin",
        freshness: "provisional",
        configOptions: [
          {
            id: "thinking_budget",
            label: "Thinking budget",
            kind: "number",
            scope: "model",
            source: "static_builtin",
            mutable: true,
            applyTiming: "next_turn",
          },
        ],
      },
    ],
  };
}

describe("provider capability helpers", () => {
  test("prefers sourceDetail over coarse source", () => {
    assert.equal(resolveCapabilitySourceLabel(catalog()), "native_online");
  });

  test("returns freshness label when present", () => {
    assert.equal(resolveCapabilityFreshnessLabel(catalog()), "authoritative");
  });

  test("returns exactness label for authoritative exact catalogs", () => {
    assert.equal(resolveCapabilityExactnessLabel(catalog()), "exact");
  });

  test("resolves active model profile from selected model id or current model id", () => {
    assert.equal(
      resolveActiveModelCapabilityProfile({ catalog: catalog() })?.modelId,
      "gpt-5.5",
    );
    assert.equal(
      resolveActiveModelCapabilityProfile({
        catalog: catalog(),
        selectedModelId: "gpt-5.4",
      }),
      null,
    );
  });

  test("resolves effective model id from selected model, then session model, then catalog", () => {
    assert.equal(
      resolveEffectiveModelId({
        catalog: catalog(),
        selectedModelId: "gpt-5.4",
      }),
      "gpt-5.4",
    );
    assert.equal(
      resolveEffectiveModelId({
        summary: {
          session: {
            id: "session-g",
            provider: "gemini",
            launchSource: "web",
            cwd: "/workspace",
            rootDir: "/workspace",
            runtimeState: "idle",
            ptyId: "pty-g",
            capabilities: {
              liveAttach: true,
              structuredTimeline: true,
              livePermissions: false,
              contextUsage: true,
              resumeByProvider: true,
              listProviderSessions: false,
              renameSession: false,
              actions: {
                info: true,
                archive: true,
                delete: true,
                rename: "local" as const,
              },
              steerInput: true,
              queuedInput: false,
              modelSwitch: false,
              planMode: false,
              subagents: false,
            },
            model: {
              currentModelId: "gemini-2.5-pro",
              availableModels: [],
              mutable: false,
              source: "fallback" as const,
            },
            createdAt: "2026-04-27T00:00:00.000Z",
            updatedAt: "2026-04-27T00:00:00.000Z",
          },
          attachedClients: [],
          controlLease: { sessionId: "session-g" },
        },
        catalog: geminiCatalog(),
      }),
      "gemini-2.5-pro",
    );
    assert.equal(resolveEffectiveModelId({ catalog: geminiCatalog() }), "auto");
  });

  test("prefers model profile config options over top-level catalog options", () => {
    assert.deepEqual(
      resolveVisibleConfigOptionLabels({ catalog: catalog() }),
      ["Reasoning effort"],
    );
  });

  test("falls back to top-level config options when no model profile exists", () => {
    const fallbackCatalog: ProviderModelCatalog = {
      ...catalog(),
      modelProfiles: [],
      modelsExact: false,
      optionsExact: false,
      freshness: "provisional",
    };
    assert.deepEqual(
      resolveVisibleConfigOptionLabels({
        catalog: fallbackCatalog,
        selectedModelId: "gpt-5.4",
      }),
      ["Global toggle"],
    );
    assert.equal(
      resolveCapabilityCautionText({ catalog: fallbackCatalog }),
      "Prelaunch capability view may change after the session starts.",
    );
    assert.equal(resolveCapabilityExactnessLabel(fallbackCatalog), "provisional");
    assert.equal(resolveCapabilityExactnessDisplay({ catalog: fallbackCatalog }), "provisional");
    assert.equal(
      resolveConfigPreviewOrigin({
        catalog: fallbackCatalog,
        selectedModelId: "gpt-5.4",
      }),
      "catalog-top-level",
    );
    assert.equal(
      resolveCapabilityHeadline({
        catalog: fallbackCatalog,
        selectedModelId: "gpt-5.4",
      }),
      "Capability preview is based on prelaunch provider data.",
    );
  });

  test("formats scalar config values for display", () => {
    assert.equal(formatSessionConfigValue(true), "on");
    assert.equal(formatSessionConfigValue(false), "off");
    assert.equal(formatSessionConfigValue(4096), "4096");
    assert.equal(formatSessionConfigValue("high"), "high");
    assert.equal(formatSessionConfigValue(null), null);
    assert.equal(formatSessionConfigValue(undefined), null);
  });

  test("builds optionValues from the selected model reasoning option", () => {
    assert.deepEqual(
      buildModelOptionValuesFromReasoning({
        catalog: catalog(),
        modelId: "gpt-5.5",
        reasoningId: "medium",
      }),
      { model_reasoning_effort: "medium" },
    );
  });

  test("builds preview rows for visible config options", () => {
    const rows = resolveConfigOptionPreviewRows({ catalog: catalog() });
    assert.deepEqual(rows, [
      {
        id: "model_reasoning_effort",
        label: "Reasoning effort",
        kind: "select",
        applyTiming: "next_turn",
        source: "native_online",
        currentValue: null,
        defaultValue: null,
        choiceCount: 2,
      },
    ]);
  });

  test("prefers session resolved config when available", () => {
    const summary = {
      session: {
        id: "session-1",
        provider: "codex",
        launchSource: "web",
        cwd: "/workspace",
        rootDir: "/workspace",
        runtimeState: "idle",
        ptyId: "pty-1",
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
            rename: "native" as const,
          },
          steerInput: true,
          queuedInput: false,
          modelSwitch: true,
          planMode: false,
          subagents: false,
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        modelProfile: catalog().modelProfiles?.[0],
        config: {
          values: {
            model_reasoning_effort: "medium",
          },
          source: "runtime_session" as const,
        },
      },
      attachedClients: [],
      controlLease: { sessionId: "session-1" },
    };

    assert.equal(resolveSessionCapabilitySourceLabel(summary), "native_online");
    assert.equal(resolveSessionCapabilityFreshnessLabel(summary), "authoritative");
    assert.equal(resolveCapabilityViewOrigin({ summary, catalog: catalog() }), "session-resolved");
    assert.equal(resolveCapabilityViewOriginLabel("session-resolved"), "runtime confirmed");
    assert.equal(resolveConfigPreviewOrigin({ summary, catalog: catalog() }), "session-resolved");
    assert.equal(resolveConfigPreviewOriginLabel("session-resolved"), "live option state");
    assert.equal(resolveCapabilityExactnessDisplay({ summary, catalog: catalog() }), null);
    assert.equal(resolveCapabilityCautionText({ summary, catalog: catalog() }), null);
    assert.equal(
      resolveCapabilityHeadline({ summary, catalog: catalog() }),
      "Model and advanced options are confirmed by the live session.",
    );
    assert.deepEqual(resolveSessionConfigPreviewRows(summary), [
      {
        id: "model_reasoning_effort",
        label: "Reasoning effort",
        kind: "select",
        applyTiming: "next_turn",
        source: "native_online",
        currentValue: "medium",
        defaultValue: null,
        choiceCount: 2,
      },
    ]);
  });

  test("uses updated Codex session truth after model and reasoning switch", () => {
    const codexCatalogAfterSwitch: ProviderModelCatalog = {
      ...catalog(),
      models: [
        ...catalog().models,
        {
          id: "gpt-beta",
          label: "GPT Beta",
          defaultReasoningId: "low",
        },
      ],
      modelProfiles: [
        ...(catalog().modelProfiles ?? []),
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

    const summary = {
      session: {
        id: "session-codex-switched",
        provider: "codex",
        launchSource: "web",
        cwd: "/workspace",
        rootDir: "/workspace",
        runtimeState: "idle",
        ptyId: "pty-codex-switched",
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
            rename: "native" as const,
          },
          steerInput: true,
          queuedInput: false,
          modelSwitch: true,
          planMode: false,
          subagents: false,
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        model: {
          currentModelId: "gpt-beta",
          currentReasoningId: "low",
          availableModels: codexCatalogAfterSwitch.models,
          mutable: true,
          source: "native" as const,
        },
        modelProfile: codexCatalogAfterSwitch.modelProfiles?.find((p) => p.modelId === "gpt-beta"),
        config: {
          values: {
            model_reasoning_effort: "low",
          },
          source: "runtime_session" as const,
        },
      },
      attachedClients: [],
      controlLease: { sessionId: "session-codex-switched" },
    };

    assert.equal(
      resolveEffectiveModelId({ summary, catalog: codexCatalogAfterSwitch }),
      "gpt-beta",
    );
    assert.deepEqual(
      resolveSessionConfigPreviewRows(summary),
      [
        {
          id: "model_reasoning_effort",
          label: "Reasoning effort",
          kind: "select",
          applyTiming: "next_turn",
          source: "native_online",
          currentValue: "low",
          defaultValue: null,
          choiceCount: 1,
        },
      ],
    );
    assert.equal(
      resolveCapabilityHeadline({ summary, catalog: codexCatalogAfterSwitch }),
      "Model and advanced options are confirmed by the live session.",
    );
  });

  test("falls back to catalog when no session capability state exists", () => {
    assert.equal(resolveCapabilityViewOrigin({ catalog: catalog() }), "catalog-fallback");
    assert.equal(resolveCapabilityViewOriginLabel("catalog-fallback"), "preview only");
    assert.equal(resolveConfigPreviewOrigin({ catalog: catalog() }), "catalog-profile");
    assert.equal(resolveConfigPreviewOriginLabel("catalog-profile"), "catalog profile");
    assert.equal(resolveCapabilityViewOrigin({}), "unavailable");
  });

  test("treats session model without live config as runtime-confirmed model but catalog-derived options", () => {
    const summary = {
      session: {
        id: "session-2",
        provider: "claude",
        launchSource: "web",
        cwd: "/workspace",
        rootDir: "/workspace",
        runtimeState: "idle",
        ptyId: "pty-2",
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
            rename: "native" as const,
          },
          steerInput: true,
          queuedInput: false,
          modelSwitch: false,
          planMode: false,
          subagents: false,
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        model: {
          currentModelId: "default",
          availableModels: [],
          mutable: false,
          source: "fallback" as const,
        },
      },
      attachedClients: [],
      controlLease: { sessionId: "session-2" },
    };

    const claudeCatalog: ProviderModelCatalog = {
      provider: "claude",
      currentModelId: "default",
      fetchedAt: "2026-04-27T00:00:00.000Z",
      source: "static",
      sourceDetail: "native_local",
      freshness: "provisional",
      modelsExact: false,
      optionsExact: false,
      models: [{ id: "default", label: "Sonnet slot" }],
      modelProfiles: [
        {
          modelId: "default",
          source: "native_local",
          freshness: "provisional",
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              kind: "select",
              scope: "model",
              source: "native_local",
              mutable: true,
              applyTiming: "next_turn",
            },
          ],
        },
      ],
    };

    assert.equal(resolveCapabilityViewOrigin({ summary, catalog: claudeCatalog }), "session-resolved");
    assert.equal(
      resolveConfigPreviewOrigin({
        summary,
        catalog: claudeCatalog,
        selectedModelId: "default",
      }),
      "catalog-profile",
    );
    assert.equal(
      resolveConfigPreviewOriginLabel("catalog-profile"),
      "catalog profile",
    );
    assert.equal(
      resolveCapabilityHeadline({
        summary,
        catalog: claudeCatalog,
        selectedModelId: "default",
      }),
      "Current model is confirmed by the live session. Advanced options are inferred from the provider catalog.",
    );
  });

  test("uses session current model to select Gemini provider-specific option profile", () => {
    const summary = {
      session: {
        id: "session-gemini",
        provider: "gemini",
        launchSource: "web",
        cwd: "/workspace",
        rootDir: "/workspace",
        runtimeState: "idle",
        ptyId: "pty-gemini",
        capabilities: {
          liveAttach: true,
          structuredTimeline: true,
          livePermissions: false,
          contextUsage: true,
          resumeByProvider: true,
          listProviderSessions: false,
          renameSession: false,
          actions: {
            info: true,
            archive: true,
            delete: true,
            rename: "local" as const,
          },
          steerInput: true,
          queuedInput: false,
          modelSwitch: false,
          planMode: false,
          subagents: false,
        },
        model: {
          currentModelId: "gemini-2.5-pro",
          availableModels: [],
          mutable: false,
          source: "fallback" as const,
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      attachedClients: [],
      controlLease: { sessionId: "session-gemini" },
    };

    assert.deepEqual(
      resolveVisibleConfigOptionLabels({
        catalog: geminiCatalog(),
        summary,
      }),
      ["Thinking budget"],
    );
    assert.equal(
      resolveConfigPreviewOrigin({
        summary,
        catalog: geminiCatalog(),
      }),
      "catalog-profile",
    );
  });
});
