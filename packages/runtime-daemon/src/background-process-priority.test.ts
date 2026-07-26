import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import test from "node:test";
import {
  applyBackgroundProcessPriority,
  backgroundProcessLaunch,
  resolveBackgroundProcessNice,
} from "./background-process-priority";

test("background process priority has a conservative default and bounded override", () => {
  assert.equal(resolveBackgroundProcessNice(undefined), 10);
  assert.equal(resolveBackgroundProcessNice("0"), 0);
  assert.equal(resolveBackgroundProcessNice("7"), 7);
  assert.equal(resolveBackgroundProcessNice("-20"), 0);
  assert.equal(resolveBackgroundProcessNice("99"), 19);
  assert.equal(resolveBackgroundProcessNice("not-a-number"), 10);
});

test("provider launch enters Darwin background policy before executing the provider", () => {
  assert.deepEqual(
    backgroundProcessLaunch("/opt/provider", ["serve", "--port", "1234"], {
      nice: 12,
      platform: "darwin",
    }),
    {
      command: "/usr/bin/nice",
      args: [
        "-n",
        "12",
        "/opt/provider",
        "serve",
        "--port",
        "1234",
      ],
      priority: {
        nice: 12,
        platform: "darwin",
        cpuPriorityAppliedBeforeExec: true,
      },
    },
  );
  assert.deepEqual(
    backgroundProcessLaunch("/opt/provider", ["serve"], {
      nice: 12,
      platform: "linux",
    }),
    {
      command: "/opt/provider",
      args: ["serve"],
      priority: {
        nice: 12,
        platform: "linux",
        cpuPriorityAppliedBeforeExec: false,
      },
    },
  );
  assert.deepEqual(
    backgroundProcessLaunch("/opt/provider", ["serve"], {
      nice: 0,
      platform: "darwin",
    }),
    {
      command: "/opt/provider",
      args: ["serve"],
      priority: {
        nice: 0,
        platform: "darwin",
        cpuPriorityAppliedBeforeExec: false,
      },
    },
  );
});

test(
  "Darwin provider niceness is applied once and inherited by descendants",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const foregroundNice = os.getPriority(0);
    const adjustment = Math.min(10, 19 - foregroundNice);
    if (adjustment <= 0) {
      context.skip("test process is already at the lowest CPU priority");
      return;
    }

    const providerScript = String.raw`
      const { spawn } = require("node:child_process");
      const os = require("node:os");
      const nested = spawn(
        process.execPath,
        ["-e", "process.stdout.write(String(require('node:os').getPriority(0)))"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      nested.stdout.on("data", (chunk) => { stdout += chunk; });
      nested.stderr.on("data", (chunk) => { stderr += chunk; });
      nested.on("close", (code) => {
        if (code !== 0) {
          process.stderr.write(stderr);
          process.exit(code ?? 1);
          return;
        }
        process.stdout.write(JSON.stringify({
          self: os.getPriority(0),
          nested: Number(stdout),
        }));
      });
    `;
    const launch = backgroundProcessLaunch(
      process.execPath,
      ["-e", providerScript],
      { nice: adjustment },
    );
    const child = spawn(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    applyBackgroundProcessPriority(
      child.pid,
      "background priority inheritance test",
      launch.priority,
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const [code, signal] = (await once(child, "close")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(
      code,
      0,
      `provider fixture failed: signal=${signal ?? "none"} stderr=${stderr}`,
    );

    const expectedNice = Math.min(19, foregroundNice + adjustment);
    assert.deepEqual(JSON.parse(stdout), {
      self: expectedNice,
      nested: expectedNice,
    });
    assert.equal(
      os.getPriority(0),
      foregroundNice,
      "lowering a provider tree must never lower the RAH control process",
    );
  },
);
