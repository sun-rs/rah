import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultModeDraft,
  resolveSessionModeControlState,
} from "./session-mode-ui";
import {
  isManualSupplementModel,
  resolveSelectedModelDraft,
} from "./components/SessionModelControls";
import type { ProviderKind, ProviderModelCatalog, SessionSummary } from "@rah/runtime-protocol";

describe("session mode UI defaults", () => {
  test("uses provider-native labels from catalogs", () => {
    const catalog = modeCatalog("opencode", "build");
    const state = resolveSessionModeControlState({
      provider: "opencode",
      catalog,
    });

    assert.deepEqual(
      state.accessModes.map((mode) => mode.label),
      ["Build", "Plan"],
    );
    assert.equal(state.selectedAccessModeId, "build");
  });

  test("uses one canonical label set for new-session and live-session controls", () => {
    const catalog = modeCatalog("codex", "never/danger-full-access");
    const preset = resolveSessionModeControlState({ provider: "codex", catalog });
    const live = resolveSessionModeControlState({
      provider: "codex",
      summary: {
        session: {
          mode: {
            currentModeId: preset.selectedAccessModeId,
            availableModes: [
              ...catalog.modes!.map((mode) => ({
                ...mode,
                label: `provider raw label for ${mode.id}`,
              })),
            ],
            mutable: true,
            source: "native",
          },
        },
      } as SessionSummary,
    });

    assert.deepEqual(
      live.accessModes.map((mode) => ({ id: mode.id, label: mode.label })),
      preset.accessModes.map((mode) => ({ id: mode.id, label: mode.label })),
    );
  });

  test("keeps the provider default mode in catalog instead of frontend presets", () => {
    assert.deepEqual(
      {
        codex: selectedAccessModeId("codex", "never/danger-full-access"),
        claude: selectedAccessModeId("claude", "bypassPermissions"),
        opencode: selectedAccessModeId("opencode", "build"),
      },
      {
        codex: "never/danger-full-access",
        claude: "bypassPermissions",
        opencode: "build",
      },
    );
  });

  test("default drafts are provider-agnostic until the catalog arrives", () => {
    assert.equal(createDefaultModeDraft("codex").accessModeId, null);
    assert.equal(createDefaultModeDraft("opencode").accessModeId, null);
  });

  test("keeps the provider catalog order for visible controls", () => {
    assert.deepEqual(
      {
        codex: lastAccessModeId("codex", "never/danger-full-access"),
        claude: lastAccessModeId("claude", "bypassPermissions"),
        opencode: lastAccessModeId("opencode", "build"),
      },
      {
        codex: "never/danger-full-access",
        claude: "bypassPermissions",
        opencode: "plan",
      },
    );
  });

  test("labels provider modes with native names", () => {
    assert.deepEqual(
      {
        claude: firstAccessModeLabel("claude", "bypassPermissions"),
        opencode: firstAccessModeLabel("opencode", "build"),
      },
      {
        claude: "Default",
        opencode: "Build",
      },
    );
  });

  test("does not expose reject-without-asking modes", () => {
    const claude = resolveSessionModeControlState({
      provider: "claude",
      catalog: modeCatalog("claude", "bypassPermissions"),
    });
    assert.equal(claude.accessModes.some((mode) => mode.id === "dontAsk"), false);
  });

  test("does not expose Claude automatic native mode in the primary UI", () => {
    const claude = resolveSessionModeControlState({
      provider: "claude",
      catalog: modeCatalog("claude", "bypassPermissions"),
    });
    assert.equal(claude.accessModes.some((mode) => mode.id === "auto"), false);
  });

  test("keeps Claude plan as a mutually exclusive session mode", () => {
    const state = resolveSessionModeControlState({
      provider: "claude",
      catalog: modeCatalog("claude", "bypassPermissions"),
      draft: { accessModeId: "plan", planEnabled: false },
    });

    assert.deepEqual(
      state.accessModes.map((mode) => mode.id),
      ["default", "acceptEdits", "plan", "bypassPermissions"],
    );
    assert.equal(state.planModeAvailable, false);
    assert.equal(state.effectiveModeId, "plan");
  });

  test("uses catalog modes when live summary has no available modes", () => {
    const state = resolveSessionModeControlState({
      provider: "codex",
      catalog: modeCatalog("codex", "never/danger-full-access"),
      summary: {
        session: {
          mode: {
            currentModeId: "never/danger-full-access",
            availableModes: [],
            mutable: true,
            source: "native",
          },
        },
      } as SessionSummary,
    });
    assert.equal(state.planModeAvailable, true);
    assert.equal(state.planModeEnabled, false);
    assert.equal(state.effectiveModeId, "never/danger-full-access");
  });

  test("normalizes stale Codex live access labels", () => {
    const state = resolveSessionModeControlState({
      provider: "codex",
      summary: {
        session: {
          mode: {
            currentModeId: "never/danger-full-access",
            availableModes: [
              {
                id: "on-request/read-only",
                label: "On request · Read only",
                role: "ask",
                hotSwitch: true,
              },
              {
                id: "never/danger-full-access",
                label: "Never · Danger full access",
                role: "full_auto",
                hotSwitch: true,
              },
              {
                id: "plan",
                label: "Plan",
                role: "plan",
                hotSwitch: true,
              },
            ],
            mutable: true,
            source: "native",
          },
        },
      } as SessionSummary,
    });

    assert.deepEqual(state.accessModes.map((mode) => mode.label), ["Ask", "Full Access"]);
    assert.equal(state.planModeAvailable, true);
  });

  test("keeps Codex plan and access preset together in the submitted mode id", () => {
    const state = resolveSessionModeControlState({
      provider: "codex",
      catalog: modeCatalog("codex", "never/danger-full-access"),
      draft: { accessModeId: "auto-review/workspace-write", planEnabled: true },
    });

    assert.equal(state.selectedAccessModeId, "auto-review/workspace-write");
    assert.equal(state.planModeEnabled, true);
    assert.equal(state.effectiveModeId, "plan:auto-review/workspace-write");
  });

  test("uses Codex live preferred access when current mode is plan", () => {
    const state = resolveSessionModeControlState({
      provider: "codex",
      catalog: modeCatalog("codex", "never/danger-full-access"),
      summary: {
        session: {
          mode: {
            currentModeId: "plan",
            availableModes: [
              {
                id: "auto-review/workspace-write",
                role: "auto_edit",
                label: "Auto Review",
                hotSwitch: true,
              },
              {
                id: "on-request/workspace-write",
                role: "ask",
                label: "Default",
                hotSwitch: true,
              },
              {
                id: "plan",
                role: "plan",
                label: "Plan",
                hotSwitch: true,
              },
              {
                id: "never/danger-full-access",
                role: "full_auto",
                label: "Full Access",
                hotSwitch: true,
              },
            ],
            mutable: true,
            source: "native",
          },
        },
      } as SessionSummary,
    });

    assert.equal(state.planModeEnabled, true);
    assert.equal(state.selectedAccessModeId, "auto-review/workspace-write");
    assert.equal(state.effectiveModeId, "plan:auto-review/workspace-write");
  });

  test("keeps OpenCode plan as an agent option instead of a separate toggle", () => {
    const state = resolveSessionModeControlState({
      provider: "opencode",
      summary: {
        session: {
          mode: {
            currentModeId: "plan",
            availableModes: [
              { id: "build", role: "custom", label: "Build", hotSwitch: true },
              { id: "plan", role: "custom", label: "Plan", hotSwitch: true },
            ],
            mutable: true,
            source: "native",
          },
        },
      } as SessionSummary,
    });

    assert.deepEqual(
      state.accessModes.map((mode) => mode.label),
      ["Build", "Plan"],
    );
    assert.equal(state.selectedAccessModeId, "plan");
    assert.equal(state.planModeAvailable, false);
  });

  test("keeps OpenCode custom agent labels provider-native", () => {
    const state = resolveSessionModeControlState({
      provider: "opencode",
      catalog: {
        provider: "opencode",
        models: [],
        fetchedAt: new Date().toISOString(),
        source: "native",
        defaultModeId: "default",
        modes: [
          { id: "default", role: "custom", label: "default", hotSwitch: true },
          { id: "yolo", role: "custom", label: "yolo", hotSwitch: true },
        ],
      },
    });

    assert.deepEqual(
      state.accessModes.map((mode) => mode.label),
      ["default", "yolo"],
    );
  });

  test("prefers provider catalog modes over frontend fallback presets", () => {
    const catalog: ProviderModelCatalog = {
      provider: "opencode",
      models: [],
      fetchedAt: new Date().toISOString(),
      source: "native",
      defaultModeId: "provider/full",
      modes: [
        { id: "provider/ask", role: "custom", label: "Provider ask", hotSwitch: true },
        { id: "plan", role: "custom", label: "Plan", hotSwitch: true },
        { id: "provider/full", role: "custom", label: "Provider full", hotSwitch: true },
      ],
    };

    const state = resolveSessionModeControlState({
      provider: "opencode",
      catalog,
    });

    assert.deepEqual(
      state.accessModes.map((mode) => mode.id),
      ["provider/ask", "plan", "provider/full"],
    );
    assert.equal(state.selectedAccessModeId, "provider/full");
    assert.equal(state.planModeAvailable, false);
  });
});

describe("session model UI defaults", () => {
  test("uses the first model and strongest reasoning when no explicit draft exists", () => {
    const state = resolveSelectedModelDraft({
      catalog: modelCatalog({
        currentModelId: "gpt-current",
        currentReasoningId: "medium",
      }),
    });

    assert.equal(state.model?.id, "gpt-default");
    assert.equal(state.reasoning?.id, "high");
  });

  test("uses explicit model and reasoning drafts over catalog defaults", () => {
    const state = resolveSelectedModelDraft({
      catalog: modelCatalog({
        currentModelId: "gpt-current",
        currentReasoningId: "medium",
      }),
      selectedModelId: "gpt-explicit",
      selectedReasoningId: "xhigh",
    });

    assert.equal(state.model?.id, "gpt-explicit");
    assert.equal(state.reasoning?.id, "xhigh");
  });

  test("preserves explicit model drafts that are not in the catalog", () => {
    const state = resolveSelectedModelDraft({
      catalog: modelCatalog({}),
      selectedModelId: "niubiwudi",
    });

    assert.equal(state.model?.id, "niubiwudi");
    assert.equal(state.reasoning?.id, undefined);
  });

  test("falls back from stale model drafts when preservation is disabled", () => {
    const state = resolveSelectedModelDraft({
      catalog: modelCatalog({}),
      selectedModelId: "deleted-manual-model",
      preserveMissingSelectedModel: false,
    });

    assert.equal(state.model?.id, "gpt-default");
    assert.equal(state.reasoning?.id, "high");
  });

  test("uses the strongest reasoning option for a remembered model", () => {
    const state = resolveSelectedModelDraft({
      catalog: modelCatalog({}),
      selectedModelId: "gpt-current",
    });

    assert.equal(state.model?.id, "gpt-current");
    assert.equal(state.reasoning?.id, "xhigh");
  });

  test("falls back to the first model instead of provider defaults", () => {
    const state = resolveSelectedModelDraft({
      catalog: modelCatalog({}),
    });

    assert.equal(state.model?.id, "gpt-default");
    assert.equal(state.reasoning?.id, "high");
  });

  test("identifies manual supplement models from catalog profiles", () => {
    const catalog = modelCatalog({});
    catalog.modelProfiles = [
      {
        modelId: "gpt-default",
        source: "native_online",
        freshness: "authoritative",
        configOptions: [],
      },
      {
        modelId: "gpt-manual",
        source: "cached_runtime",
        freshness: "stale",
        configOptions: [],
      },
    ];

    assert.equal(isManualSupplementModel(catalog, "gpt-manual"), true);
    assert.equal(isManualSupplementModel(catalog, "gpt-default"), false);
  });
});

function lastAccessModeId(
  provider: "codex" | "claude" | "opencode",
  defaultModeId: string,
): string | null {
  const state = resolveSessionModeControlState({
    provider,
    catalog: modeCatalog(provider, defaultModeId),
  });
  return state.accessModes.at(-1)?.id ?? null;
}

function firstAccessModeLabel(
  provider: "codex" | "claude" | "opencode",
  defaultModeId: string,
): string | null {
  const state = resolveSessionModeControlState({
    provider,
    catalog: modeCatalog(provider, defaultModeId),
  });
  return state.accessModes[0]?.label ?? null;
}

function selectedAccessModeId(provider: ProviderKind, defaultModeId: string): string | null {
  return resolveSessionModeControlState({
    provider,
    catalog: modeCatalog(provider, defaultModeId),
  }).selectedAccessModeId;
}

function modeCatalog(provider: ProviderKind, defaultModeId: string): ProviderModelCatalog {
  const modes = {
    codex: [
      { id: "on-request/workspace-write", role: "ask", label: "Default", hotSwitch: true },
      { id: "auto-review/workspace-write", role: "auto_edit", label: "Auto Review", hotSwitch: true },
      { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
      { id: "never/danger-full-access", role: "full_auto", label: "Full Access", hotSwitch: true },
    ],
    claude: [
      { id: "default", role: "ask", label: "Default", hotSwitch: true },
      { id: "acceptEdits", role: "auto_edit", label: "Accept Edits", hotSwitch: true },
      { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
      { id: "bypassPermissions", role: "full_auto", label: "Bypass Permissions", hotSwitch: true },
    ],
    opencode: [
      { id: "build", role: "custom", label: "Build", hotSwitch: true },
      { id: "plan", role: "custom", label: "Plan", hotSwitch: true },
    ],
    custom: [],
  } satisfies Record<ProviderKind, NonNullable<ProviderModelCatalog["modes"]>>;
  return {
    provider,
    models: [],
    fetchedAt: new Date().toISOString(),
    source: "native",
    defaultModeId,
    modes: modes[provider],
  };
}

function modelCatalog(options: {
  currentModelId?: string;
  currentReasoningId?: string;
}): ProviderModelCatalog {
  return {
    provider: "codex",
    ...(options.currentModelId ? { currentModelId: options.currentModelId } : {}),
    ...(options.currentReasoningId ? { currentReasoningId: options.currentReasoningId } : {}),
    models: [
      {
        id: "gpt-default",
        isDefault: true,
        defaultReasoningId: "high",
        reasoningOptions: [
          { id: "low", label: "Low", kind: "reasoning_effort" },
          { id: "high", label: "High", kind: "reasoning_effort" },
        ],
      },
      {
        id: "gpt-current",
        defaultReasoningId: "low",
        reasoningOptions: [
          { id: "low", label: "Low", kind: "reasoning_effort" },
          { id: "medium", label: "Medium", kind: "reasoning_effort" },
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
      },
      {
        id: "gpt-explicit",
        defaultReasoningId: "medium",
        reasoningOptions: [
          { id: "medium", label: "Medium", kind: "reasoning_effort" },
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
      },
      {
        id: "gpt-last",
        defaultReasoningId: "low",
        reasoningOptions: [
          { id: "low", label: "Low", kind: "reasoning_effort" },
        ],
      },
    ],
    fetchedAt: new Date().toISOString(),
    source: "native",
  };
}
