import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  SESSION_MODEL_PREFERENCES_MAX_ENTRIES,
  SESSION_MODEL_PREFERENCES_STORAGE_KEY,
  readSessionModelPreference,
  rememberSessionModelPreference,
  sessionModelPreferenceKey,
} from "./session-model-preferences";
import { startSessionAndRememberModel } from "./session-start-model-preferences";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("session model preferences", () => {
  test("uses the provider session identity across stopped and resumed RAH sessions", () => {
    assert.equal(
      sessionModelPreferenceKey({
        id: "history-runtime-id",
        provider: "codex",
        providerSessionId: "thread-42",
      }),
      sessionModelPreferenceKey({
        id: "resumed-runtime-id",
        provider: "codex",
        providerSessionId: "thread-42",
      }),
    );
  });

  test("restores the exact model, effort, and backend option values", () => {
    const storage = memoryStorage();
    const owner = {
      id: "session-a",
      provider: "codex",
      providerSessionId: "thread-a",
    };
    rememberSessionModelPreference(
      storage,
      owner,
      {
        modelId: "gpt-5.6-sol",
        reasoningId: "medium",
        optionValues: { reasoning_effort: "medium" },
      },
      100,
    );

    assert.deepEqual(readSessionModelPreference(storage, owner), {
      modelId: "gpt-5.6-sol",
      reasoningId: "medium",
      optionValues: { reasoning_effort: "medium" },
    });
  });

  test("keeps explicit null parameters instead of falling back to the strongest option", () => {
    const storage = memoryStorage();
    const owner = { id: "session-default", provider: "claude" };
    rememberSessionModelPreference(
      storage,
      owner,
      { modelId: "claude-sonnet", reasoningId: null },
      100,
    );

    assert.deepEqual(readSessionModelPreference(storage, owner), {
      modelId: "claude-sonnet",
      reasoningId: null,
    });
  });

  test("bounds stale preferences while retaining the newest sessions", () => {
    const storage = memoryStorage();
    for (let index = 0; index < SESSION_MODEL_PREFERENCES_MAX_ENTRIES + 3; index += 1) {
      rememberSessionModelPreference(
        storage,
        { id: `session-${index}`, provider: "codex" },
        { modelId: "gpt-5.6-sol", reasoningId: index % 2 === 0 ? "high" : "medium" },
        index,
      );
    }

    const stored = JSON.parse(
      storage.values.get(SESSION_MODEL_PREFERENCES_STORAGE_KEY) ?? "{}",
    ) as { entries?: Record<string, unknown> };
    assert.equal(Object.keys(stored.entries ?? {}).length, SESSION_MODEL_PREFERENCES_MAX_ENTRIES);
    assert.equal(
      readSessionModelPreference(storage, { id: "session-0", provider: "codex" }),
      undefined,
    );
    assert.equal(
      readSessionModelPreference(storage, {
        id: `session-${SESSION_MODEL_PREFERENCES_MAX_ENTRIES + 2}`,
        provider: "codex",
      })?.reasoningId,
      "high",
    );
  });

  test("remembers a new Session model before and after provider identity binding", async () => {
    const remembered: Array<[string, unknown]> = [];
    const sessionId = await startSessionAndRememberModel(
      async (options) => {
        options?.onSessionCreated?.("pending-session");
        return "live-session";
      },
      (id, draft) => remembered.push([id, draft]),
      { model: "gpt-5.6-sol", reasoningId: "medium" },
    );

    assert.equal(sessionId, "live-session");
    assert.deepEqual(remembered, [
      ["pending-session", { modelId: "gpt-5.6-sol", reasoningId: "medium" }],
      ["live-session", { modelId: "gpt-5.6-sol", reasoningId: "medium" }],
    ]);
  });

  test("wires persisted preferences into every Session composer path", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const draftOwnerSource = readFileSync(
      new URL("./hooks/useSessionModelDrafts.ts", import.meta.url),
      "utf8",
    );
    const startPreferenceSource = readFileSync(
      new URL("./session-start-model-preferences.ts", import.meta.url),
      "utf8",
    );

    assert.match(appSource, /useSessionModelDrafts/);
    assert.match(draftOwnerSource, /const modelDraftForSession = useCallback/);
    assert.match(draftOwnerSource, /readSessionModelPreference\(/);
    assert.match(draftOwnerSource, /rememberSessionModelPreference\(/);
    assert.match(appSource, /resumeModelDraft=\{modelDraftForSession\(summary\.session\.id\)\}/);
    assert.match(appSource, /onResumeModelDraftChange=\{updateResumeModelDraft\}/);
    assert.match(appSource, /updateResumeModelDraft\(selectedSummary\.session\.id, nextDraft\)/);
    assert.match(draftOwnerSource, /const startSessionWithRememberedModel = useCallback/);
    assert.match(startPreferenceSource, /rememberStartedModel\(sessionId\)/);
    assert.equal((appSource.match(/await startSessionWithRememberedModel\(/g) ?? []).length, 2);
  });
});
