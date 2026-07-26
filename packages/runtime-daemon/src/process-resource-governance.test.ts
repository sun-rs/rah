import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

function productionTypeScriptFiles(): string[] {
  return readdirSync(new URL(".", import.meta.url), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => entry.name)
    .sort();
}

test("all direct child-process imports stay inside the reviewed process boundary", () => {
  const files = productionTypeScriptFiles().filter((name) =>
    source(`./${name}`).includes('from "node:child_process"'),
  );
  assert.deepEqual(files, [
    "background-command.ts",
    "background-ipc-task.ts",
    "background-process-priority.ts",
    "claude-model-catalog.ts",
    "codex-app-server-client.ts",
    "codex-live-rpc.ts",
    "independent-terminal.ts",
    "native-terminal-process.ts",
    "opencode-acp-client.ts",
    "opencode-api.ts",
    "opencode-stored-sessions.ts",
    "workspace-path-utils.ts",
  ]);
});

test("Darwin background policy preserves the provider as the owned child process", () => {
  const implementation = source("./background-process-priority.ts");
  const launch = implementation.slice(
    implementation.indexOf("export function backgroundProcessLaunch("),
    implementation.indexOf("export function applyBackgroundProcessPriority("),
  );
  assert.match(launch, /command: DARWIN_NICE_PATH/);
  assert.doesNotMatch(launch, /command: DARWIN_TASKPOLICY_PATH/);
  assert.match(implementation, /spawn\([\s\S]*DARWIN_TASKPOLICY_PATH/);
  assert.doesNotMatch(implementation, /spawnSync/);
  assert.match(implementation, /\["-b", "-p", String\(pid\)\]/);
  assert.match(implementation, /policy\.unref\(\)/);
  assert.match(
    implementation,
    /if \(!plan\.cpuPriorityAppliedBeforeExec\) \{[\s\S]*os\.setPriority/,
  );
});

test("every RAH-owned background process carries one launch priority plan through spawn", () => {
  for (const name of [
    "background-command.ts",
    "background-ipc-task.ts",
    "claude-model-catalog.ts",
    "codex-app-server-client.ts",
    "native-terminal-process.ts",
    "opencode-acp-client.ts",
    "opencode-api.ts",
    "workspace-path-utils.ts",
  ]) {
    const implementation = source(`./${name}`);
    assert.match(
      implementation,
      /backgroundProcessLaunch/,
      `${name} must apply the pre-spawn background process policy`,
    );
    assert.match(
      implementation,
      /applyBackgroundProcessPriority/,
      `${name} must apply the plan's platform-specific post-spawn policy`,
    );
    assert.match(
      implementation,
      /applyBackgroundProcessPriority\([\s\S]{0,300}launch\.priority/,
      `${name} must pass the exact launch plan so CPU priority cannot be applied twice`,
    );
  }
});

test("interactive terminal relay keeps UI I/O foreground but backgrounds its provider tree", () => {
  const relay = source("./independent-terminal.ts");
  assert.match(relay, /BackpressuredByteIngress/);
  const host = source("./independent-terminal-host.py");
  assert.match(host, /def apply_background_priority/);
  assert.match(host, /def start_darwin_background_policy/);
  assert.match(host, /\[taskpolicy, "-b", "-p", str\(pid\)\]/);
  assert.doesNotMatch(host, /os\.execvpe\(taskpolicy/);
});

test("no production history parser can re-enter the daemon through worker threads", () => {
  const offenders = productionTypeScriptFiles().filter((name) =>
    source(`./${name}`).includes("node:worker_threads"),
  );
  assert.deepEqual(offenders, []);
});

test("legacy synchronous OpenCode helpers stay out of runtime hot paths", () => {
  const implementation = source("./opencode-stored-sessions.ts");
  assert.match(implementation, /async function execOpenCodeProcessAsync/);
  assert.match(implementation, /runBackgroundCommand/);
  const adapter = source("./opencode-stored-history-adapter.ts");
  assert.match(adapter, /deleteOpenCodeStoredSessionAsync/);
  assert.match(adapter, /restoreOpenCodeStoredSessionAsync/);
  assert.match(adapter, /findOpenCodeStoredSessionRecordAsync/);
  const runtimeLookup = adapter.slice(
    adapter.indexOf("private async findRecordForRuntimeSession("),
    adapter.indexOf("private async findRecord("),
  );
  assert.doesNotMatch(runtimeLookup, /discoverOpenCodeStoredSessions/);
});
