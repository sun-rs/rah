import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultModeDraft,
  resolveSessionModeControlState,
} from "./session-mode-ui";
import type { SessionSummary } from "@rah/runtime-protocol";

describe("session mode UI defaults", () => {
  test("defaults every provider to the maximum-permission access mode", () => {
    assert.deepEqual(
      {
        codex: createDefaultModeDraft("codex").accessModeId,
        claude: createDefaultModeDraft("claude").accessModeId,
        gemini: createDefaultModeDraft("gemini").accessModeId,
        kimi: createDefaultModeDraft("kimi").accessModeId,
        opencode: createDefaultModeDraft("opencode").accessModeId,
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

  test("keeps full-auto access modes as the final visible option", () => {
    assert.deepEqual(
      {
        codex: lastAccessModeId("codex"),
        claude: lastAccessModeId("claude"),
        gemini: lastAccessModeId("gemini"),
        kimi: lastAccessModeId("kimi"),
        opencode: lastAccessModeId("opencode"),
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
        claude: firstAccessModeLabel("claude"),
        gemini: firstAccessModeLabel("gemini"),
        kimi: firstAccessModeLabel("kimi"),
        opencode: firstAccessModeLabel("opencode"),
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
    const claude = resolveSessionModeControlState({ provider: "claude" });
    assert.equal(claude.accessModes.some((mode) => mode.id === "dontAsk"), false);
  });

  test("does not expose Claude automatic native mode in the primary UI", () => {
    const claude = resolveSessionModeControlState({ provider: "claude" });
    assert.equal(claude.accessModes.some((mode) => mode.id === "auto"), false);
  });

  test("falls back to provider plan support when live summary omits plan", () => {
    const state = resolveSessionModeControlState({
      provider: "codex",
      summary: {
        session: {
          mode: {
            currentModeId: "never/danger-full-access",
            availableModes: [
              {
                id: "never/danger-full-access",
                label: "Full auto",
                hotSwitch: true,
              },
            ],
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
                hotSwitch: true,
              },
              {
                id: "never/danger-full-access",
                label: "Never · Danger full access",
                hotSwitch: true,
              },
              {
                id: "plan",
                label: "Plan",
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
      ["Read only", "Full auto"],
    );
    assert.equal(state.planModeAvailable, true);
  });
});

function lastAccessModeId(
  provider: "codex" | "claude" | "gemini" | "kimi" | "opencode",
): string | null {
  const state = resolveSessionModeControlState({ provider });
  return state.accessModes.at(-1)?.id ?? null;
}

function firstAccessModeLabel(
  provider: "codex" | "claude" | "gemini" | "kimi" | "opencode",
): string | null {
  const state = resolveSessionModeControlState({ provider });
  return state.accessModes[0]?.label ?? null;
}
