import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCanonicalSessionTitle,
  resolveSessionTitleAndPreview,
} from "./session-title-resolver";

describe("session title resolver", () => {
  test("resolves title from override, provider history, then live fallback", () => {
    const session = {
      provider: "codex" as const,
      providerSessionId: "thread-1",
      title: "Live fallback",
    };

    assert.equal(
      resolveCanonicalSessionTitle(session, {
        discoveredStoredSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-1",
            title: "Provider title",
          },
        ],
      }),
      "Provider title",
    );

    assert.equal(
      resolveCanonicalSessionTitle(session, {
        titleOverrides: {
          "codex:thread-1": "User title",
        },
        discoveredStoredSessions: [
          {
            provider: "codex",
            providerSessionId: "thread-1",
            title: "Provider title",
          },
        ],
      }),
      "User title",
    );

    assert.equal(resolveCanonicalSessionTitle(session), "Live fallback");
  });

  test("keeps provider preview out of the canonical title", () => {
    assert.deepEqual(
      resolveSessionTitleAndPreview({
        providerPreview: "Old first prompt",
      }),
      {
        preview: "Old first prompt",
      },
    );

    assert.deepEqual(
      resolveSessionTitleAndPreview({
        providerTitle: "Renamed thread",
        providerPreview: "Old first prompt",
      }),
      {
        title: "Renamed thread",
        preview: "Old first prompt",
      },
    );
  });
});
