import assert from "node:assert/strict";
import { test } from "node:test";
import { createTimelineIdentity } from "./timeline-identity";
import {
  recordTimelineIdentityTelemetry,
  releaseTimelineIdentityTelemetrySession,
  resetTimelineIdentityTelemetryForTests,
  setTimelineIdentityTelemetryWarnSinkForTests,
  type TimelineIdentityTelemetryWarning,
} from "./timeline-identity-telemetry";

test("releasing a session removes its collision warning state", () => {
  resetTimelineIdentityTelemetryForTests();
  const services = {};
  const warnings: TimelineIdentityTelemetryWarning[] = [];
  setTimelineIdentityTelemetryWarnSinkForTests((warning) => warnings.push(warning));
  const baseIdentity = createTimelineIdentity({
    provider: "codex",
    providerSessionId: "provider-session-release",
    turnKey: "turn-release",
    itemKind: "assistant_message",
    itemKey: "first",
    origin: "live",
    confidence: "native",
  });
  const recordConflict = () => {
    for (const itemKey of ["first", "second"]) {
      recordTimelineIdentityTelemetry(services, {
        sessionId: "session-release",
        provider: "codex",
        activityType: "timeline_item",
        item: { kind: "assistant_message", text: itemKey },
        identity: { ...baseIdentity, itemKey },
      });
    }
  };

  recordConflict();
  assert.equal(warnings.filter((warning) => warning.code === "timeline.identity.collision").length, 1);

  releaseTimelineIdentityTelemetrySession(services, "session-release");
  recordConflict();

  assert.equal(warnings.filter((warning) => warning.code === "timeline.identity.collision").length, 2);
  resetTimelineIdentityTelemetryForTests();
});
