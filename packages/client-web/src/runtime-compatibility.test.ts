import assert from "node:assert/strict";
import test from "node:test";

import { deriveRuntimeCompatibilityDescriptor } from "./runtime-compatibility";

test("reports only exact Web and daemon generation mismatches", () => {
  assert.equal(
    deriveRuntimeCompatibilityDescriptor("same", {
      pid: 12,
      webBuildId: "same",
    }),
    null,
  );
  assert.equal(
    deriveRuntimeCompatibilityDescriptor("", {
      pid: 12,
      webBuildId: "daemon",
    }),
    null,
  );
  assert.match(
    deriveRuntimeCompatibilityDescriptor("browser", {
      pid: 12,
    })?.body ?? "",
    /pre-generation build/,
  );

  const mismatch = deriveRuntimeCompatibilityDescriptor(
    "browser-generation",
    {
      pid: 42,
      webBuildId: "daemon-generation",
    },
  );
  assert.equal(mismatch?.title, "RAH daemon restart required");
  assert.equal(mismatch?.primaryLabel, "Check again");
  assert.match(mismatch?.body ?? "", /daemon 42/);
  assert.match(mismatch?.body ?? "", /browser-/);
  assert.match(mismatch?.body ?? "", /daemon-g/);
});
