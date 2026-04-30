import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultModeDraft,
  resolveSessionModeControlState,
} from "./session-mode-ui";
import { resolveSelectedModelDraft } from "./components/SessionModelControls";
import type { ProviderKind, ProviderModelCatalog, SessionSummary } from "@rah/runtime-protocol";

describe("session mode UI defaults", () => {
  test("uses mode roles from provider catalogs for canonical labels", () => {
    const catalog = modeCatalog("gemini", "yolo");
    const state = resolveSessionModeControlState({
      provider: "gemini",
      catalog,
    });

    assert.deepEqual(
      state.accessModes.map((mode) => mode.label),
      ["Ask", "Auto edit", "Full auto"],
    );
    assert.equal(state.selectedAccessModeId, "yolo");
  });

  test("uses one canonical label set for new-session and live-session controls", () => {
    const catalog = modeCatalog("gemini", "yolo");
    const preset = resolveSessionModeControlState({ provider: "gemini", catalog });
    const live = resolveSessionModeControlState({
      provider: "gemini",
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
        gemini: selectedAccessModeId("gemini", "yolo"),
        kimi: selectedAccessModeId("kimi", "yolo"),
        opencode: selectedAccessModeId("opencode", "opencode/full-auto"),
      },
      {
        codex: "never/danger-full-access",
        claude: "bypassPermissions",
        gemini: "yolo",
        kimi: "yolo",
        opencode: "opencode/full-auto",
      },
    );
  });

  test("default drafts are provider-agnostic until the catalog arrives", () => {
    assert.equal(createDefaultModeDraft("codex").accessModeId, null);
    assert.equal(createDefaultModeDraft("gemini").accessModeId, null);
  });

  test("keeps full-auto access modes as the final visible option", () => {
    assert.deepEqual(
      {
        codex: lastAccessModeId("codex", "never/danger-full-access"),
        claude: lastAccessModeId("claude", "bypassPermissions"),
        gemini: lastAccessModeId("gemini", "yolo"),
        kimi: lastAccessModeId("kimi", "yolo"),
        opencode: lastAccessModeId("opencode", "opencode/full-auto"),
      },
      {
        codex: "never/danger-full-access",
        claude: "bypassPermissions",
        gemini: "yolo",
        kimi: "yolo",
        opencode: "opencode/full-auto",
      },
    );
  });

  test("labels provider prompt modes as Ask", () => {
    assert.deepEqual(
      {
        claude: firstAccessModeLabel("claude", "bypassPermissions"),
        gemini: firstAccessModeLabel("gemini", "yolo"),
        kimi: firstAccessModeLabel("kimi", "yolo"),
        opencode: firstAccessModeLabel("opencode", "opencode/full-auto"),
      },
      {
        claude: "Ask",
        gemini: "Ask",
        kimi: "Ask",
        opencode: "Ask",
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

    assert.deepEqual(
      state.accessModes.map((mode) => mode.label),
      ["Ask", "Full auto"],
    );
    assert.equal(state.planModeAvailable, true);
  });

  test("normalizes provider yolo labels to the standard Full auto wording", () => {
    const state = resolveSessionModeControlState({
      provider: "gemini",
      summary: {
        session: {
          mode: {
            currentModeId: "yolo",
            availableModes: [
              { id: "default", label: "Ask", hotSwitch: true },
              { id: "auto_edit", label: "Auto edit", hotSwitch: true },
              { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
              { id: "yolo", role: "full_auto", label: "YOLO", hotSwitch: true },
            ],
            mutable: true,
            source: "native",
          },
        },
      } as SessionSummary,
    });

    assert.deepEqual(
      state.accessModes.map((mode) => mode.label),
      ["Ask", "Auto edit", "Full auto"],
    );
    assert.equal(state.selectedAccessModeId, "yolo");
  });

  test("prefers provider catalog modes over frontend fallback presets", () => {
    const catalog: ProviderModelCatalog = {
      provider: "gemini",
      models: [],
      fetchedAt: new Date().toISOString(),
      source: "native",
      defaultModeId: "provider/full",
      modes: [
        { id: "provider/ask", role: "ask", label: "Provider ask", hotSwitch: true },
        { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
        { id: "provider/full", role: "full_auto", label: "Provider full", hotSwitch: true },
      ],
    };

    const state = resolveSessionModeControlState({
      provider: "gemini",
      catalog,
    });

    assert.deepEqual(
      state.accessModes.map((mode) => mode.id),
      ["provider/ask", "provider/full"],
    );
    assert.equal(state.selectedAccessModeId, "provider/full");
    assert.equal(state.planModeAvailable, true);
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
});

function lastAccessModeId(
  provider: "codex" | "claude" | "gemini" | "kimi" | "opencode",
  defaultModeId: string,
): string | null {
  const state = resolveSessionModeControlState({
    provider,
    catalog: modeCatalog(provider, defaultModeId),
  });
  return state.accessModes.at(-1)?.id ?? null;
}

function firstAccessModeLabel(
  provider: "codex" | "claude" | "gemini" | "kimi" | "opencode",
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
      { id: "on-request/read-only", role: "ask", label: "Ask", hotSwitch: true },
      { id: "on-request/workspace-write", role: "auto_edit", label: "Auto edit", hotSwitch: true },
      { id: "never/workspace-write", role: "full_auto", label: "Full auto · sandboxed", hotSwitch: true },
      { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
      { id: "never/danger-full-access", role: "full_auto", label: "Full auto", hotSwitch: true },
    ],
    claude: [
      { id: "default", role: "ask", label: "Ask", hotSwitch: true },
      { id: "acceptEdits", role: "auto_edit", label: "Auto edit", hotSwitch: true },
      { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
      { id: "bypassPermissions", role: "full_auto", label: "Full auto", hotSwitch: true },
    ],
    gemini: [
      { id: "default", role: "ask", label: "Ask", hotSwitch: true },
      { id: "auto_edit", role: "auto_edit", label: "Auto edit", hotSwitch: true },
      { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
      { id: "yolo", role: "full_auto", label: "Full auto", hotSwitch: true },
    ],
    kimi: [
      { id: "default", role: "ask", label: "Ask", hotSwitch: true },
      { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
      { id: "yolo", role: "full_auto", label: "Full auto", hotSwitch: true },
    ],
    opencode: [
      { id: "build", role: "ask", label: "Ask", hotSwitch: true },
      { id: "plan", role: "plan", label: "Plan", hotSwitch: true },
      { id: "opencode/full-auto", role: "full_auto", label: "Full auto", hotSwitch: true },
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
        label: "GPT Default",
        isDefault: true,
        defaultReasoningId: "high",
        reasoningOptions: [
          { id: "low", label: "Low", kind: "reasoning_effort" },
          { id: "high", label: "High", kind: "reasoning_effort" },
        ],
      },
      {
        id: "gpt-current",
        label: "GPT Current",
        defaultReasoningId: "low",
        reasoningOptions: [
          { id: "low", label: "Low", kind: "reasoning_effort" },
          { id: "medium", label: "Medium", kind: "reasoning_effort" },
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
      },
      {
        id: "gpt-explicit",
        label: "GPT Explicit",
        defaultReasoningId: "medium",
        reasoningOptions: [
          { id: "medium", label: "Medium", kind: "reasoning_effort" },
          { id: "xhigh", label: "XHigh", kind: "reasoning_effort" },
        ],
      },
      {
        id: "gpt-last",
        label: "GPT Last",
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
