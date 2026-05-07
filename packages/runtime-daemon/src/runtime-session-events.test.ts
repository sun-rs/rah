import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventBus } from "./event-bus";
import {
  attachClientAndMaybeClaimControl,
  ensureClientAttachedAndPublish,
  publishSessionCreatedAndStarted,
  publishSessionStarted,
  publishSessionStateChanged,
} from "./runtime-session-events";
import { SessionStore } from "./session-store";

function testDeps() {
  return {
    eventBus: new EventBus(),
    sessionStore: new SessionStore(),
  };
}

describe("runtime session event helpers", () => {
  test("publishes created and started from the stored session snapshot", () => {
    const deps = testDeps();
    const state = deps.sessionStore.createManagedSession({
      id: "session-events-created",
      provider: "codex",
      launchSource: "web",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
      title: "Native TUI",
    });

    publishSessionCreatedAndStarted(deps, state.session.id);

    const events = deps.eventBus.list({ sessionIds: [state.session.id] });
    assert.deepEqual(events.map((event) => event.type), [
      "session.created",
      "session.started",
    ]);
    assert.equal(events[0]?.type, "session.created");
    assert.equal(events[1]?.type, "session.started");
    if (events[0]?.type === "session.created") {
      assert.equal(events[0].payload.session.title, "Native TUI");
    }
    if (events[1]?.type === "session.started") {
      assert.equal(events[1].payload.session.title, "Native TUI");
    }
  });

  test("attaches and claims control with canonical event payloads", () => {
    const deps = testDeps();
    const state = deps.sessionStore.createManagedSession({
      id: "session-events-attach",
      provider: "codex",
      launchSource: "web",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
    });

    attachClientAndMaybeClaimControl(deps, {
      sessionId: state.session.id,
      client: {
        id: "web-native",
        kind: "web",
        connectionId: "web-native",
      },
      mode: "interactive",
      claimControl: true,
    });

    const events = deps.eventBus
      .list({ sessionIds: [state.session.id] })
      .map((event) => ({
        type: event.type,
        payload: event.payload,
      }));
    assert.deepEqual(events, [
      {
        type: "session.attached",
        payload: {
          clientId: "web-native",
          clientKind: "web",
        },
      },
      {
        type: "control.claimed",
        payload: {
          clientId: "web-native",
          clientKind: "web",
        },
      },
    ]);
  });

  test("ensure attach does not emit duplicate attached events", () => {
    const deps = testDeps();
    const state = deps.sessionStore.createManagedSession({
      id: "session-events-ensure",
      provider: "codex",
      launchSource: "web",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
    });
    const client = {
      id: "web-native",
      kind: "web" as const,
      connectionId: "web-native",
    };

    ensureClientAttachedAndPublish(deps, {
      sessionId: state.session.id,
      client,
      mode: "interactive",
    });
    ensureClientAttachedAndPublish(deps, {
      sessionId: state.session.id,
      client,
      mode: "interactive",
    });

    assert.deepEqual(
      deps.eventBus.list({ sessionIds: [state.session.id] }).map((event) => event.type),
      ["session.attached"],
    );
  });

  test("publishes started and runtime state changes", () => {
    const deps = testDeps();
    const state = deps.sessionStore.createManagedSession({
      id: "session-events-state",
      provider: "codex",
      launchSource: "web",
      cwd: "/tmp/rah",
      rootDir: "/tmp/rah",
    });

    publishSessionStarted(deps, state.session.id);
    publishSessionStateChanged(deps, state.session.id, "idle");

    assert.deepEqual(
      deps.eventBus.list({ sessionIds: [state.session.id] }).map((event) => event.type),
      ["session.started", "session.state.changed"],
    );
  });
});
