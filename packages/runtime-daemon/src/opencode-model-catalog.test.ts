import assert from "node:assert/strict";
import test from "node:test";
import { mapOpenCodeAgentModeDescriptors } from "./opencode-model-catalog";

test("OpenCode /agent mapping keeps visible primary agents and filters hidden/subagent entries", () => {
  const modes = mapOpenCodeAgentModeDescriptors([
    {
      name: "build",
      description: "The default agent.",
      mode: "primary",
      native: true,
    },
    {
      name: "compaction",
      mode: "primary",
      hidden: true,
    },
    {
      name: "explore",
      mode: "subagent",
      hidden: false,
    },
    {
      name: "plan",
      description: "Plan mode.",
      mode: "primary",
    },
    {
      name: "sisyfus",
      description: "Custom primary agent.",
      mode: "primary",
    },
  ]);

  assert.deepEqual(
    modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
    })),
    [
      { id: "build", label: "build", description: "The default agent." },
      { id: "plan", label: "plan", description: "Plan mode." },
      { id: "sisyfus", label: "sisyfus", description: "Custom primary agent." },
    ],
  );
});

test("OpenCode /agent mapping falls back to build and plan when no visible primary agents exist", () => {
  const modes = mapOpenCodeAgentModeDescriptors([
    { name: "compaction", mode: "primary", hidden: true },
    { name: "explore", mode: "subagent" },
  ]);

  assert.deepEqual(
    modes.map((mode) => mode.id),
    ["build", "plan"],
  );
});
