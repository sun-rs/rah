import type {
  ContextUsage,
  DebugScenarioDescriptor,
  MessagePartRef,
  RuntimeOperation,
  PermissionRequest,
  PermissionResolution,
  TimelineItem,
  ToolCall,
  ToolCallDetail,
  WorkbenchObservation,
} from "@rah/runtime-protocol";

type BaseStep = {
  delayMs: number;
};

export type DebugScenarioStep =
  | (BaseStep & { kind: "pty"; data: string })
  | (BaseStep & { kind: "turn_started"; turnId?: string })
  | (BaseStep & { kind: "turn_completed"; turnId?: string; usage?: ContextUsage })
  | (BaseStep & { kind: "turn_failed"; turnId?: string; error: string; code?: string })
  | (BaseStep & { kind: "turn_canceled"; turnId?: string; reason: string })
  | (BaseStep & { kind: "timeline"; turnId?: string; item: TimelineItem })
  | (BaseStep & { kind: "message_part_added"; turnId?: string; part: MessagePartRef })
  | (BaseStep & { kind: "message_part_delta"; turnId?: string; part: MessagePartRef })
  | (BaseStep & { kind: "message_part_updated"; turnId?: string; part: MessagePartRef })
  | (BaseStep & { kind: "message_part_removed"; turnId?: string; messageId: string; partId: string })
  | (BaseStep & { kind: "tool_started"; turnId?: string; toolCall: ToolCall })
  | (BaseStep & { kind: "tool_delta"; turnId?: string; toolCallId: string; detail: ToolCallDetail })
  | (BaseStep & { kind: "tool_completed"; turnId?: string; toolCall: ToolCall })
  | (BaseStep & { kind: "tool_failed"; turnId?: string; toolCallId: string; error: string })
  | (BaseStep & { kind: "observation_started"; turnId?: string; observation: WorkbenchObservation })
  | (BaseStep & { kind: "observation_updated"; turnId?: string; observation: WorkbenchObservation })
  | (BaseStep & { kind: "observation_completed"; turnId?: string; observation: WorkbenchObservation })
  | (BaseStep & { kind: "observation_failed"; turnId?: string; observation: WorkbenchObservation; error?: string })
  | (BaseStep & { kind: "permission_requested"; turnId?: string; request: PermissionRequest })
  | (BaseStep & { kind: "permission_resolved"; turnId?: string; resolution: PermissionResolution })
  | (BaseStep & { kind: "usage"; turnId?: string; usage: ContextUsage })
  | (BaseStep & { kind: "operation_started"; turnId?: string; operation: RuntimeOperation })
  | (BaseStep & { kind: "operation_resolved"; turnId?: string; operation: RuntimeOperation })
  | (BaseStep & { kind: "operation_requested"; turnId?: string; operation: RuntimeOperation })
  | (BaseStep & {
      kind: "runtime_status";
      turnId?: string;
      status:
        | "connecting"
        | "connected"
        | "authenticated"
        | "session_active"
        | "thinking"
        | "streaming"
        | "retrying"
        | "finished"
        | "error";
      detail?: string;
      retryCount?: number;
    })
  | (BaseStep & {
      kind: "notification";
      turnId?: string;
      level: "info" | "warning" | "critical";
      title: string;
      body: string;
      url?: string;
    })
  | (BaseStep & { kind: "attention_cleared"; turnId?: string; id: string })
  | (BaseStep & {
      kind: "attention";
      reason: "permission_needed" | "turn_finished" | "turn_failed";
      title: string;
      body: string;
      dedupeKey: string;
      level?: "info" | "warning" | "critical";
    });

export interface DebugScenario extends DebugScenarioDescriptor {
  steps: DebugScenarioStep[];
}

const refactorTurnId = "turn-refactor-1";
const permissionTurnId = "turn-permission-1";
const structuredTurnId = "turn-structured-ui-1";

const codexRefactorScenario: DebugScenario = {
  id: "codex-rah-refactor",
  label: "Codex: refactor + patch + build",
  description:
    "Derived from a real local Codex rollout while refactoring rah. Includes shell output, code patches, and final build verification.",
  provider: "codex",
  cwd: "/workspace/rah",
  rootDir: "/workspace/rah",
  title: "Refactor projection helpers and inspector pane",
  preview: "Tighten type-safe projection helpers and verify the build.",
  steps: [
    { delayMs: 60, kind: "turn_started", turnId: refactorTurnId },
    {
      delayMs: 90,
      kind: "timeline",
      turnId: refactorTurnId,
      item: {
        kind: "user_message",
        text: "Tighten the client-web projection helpers, fix resume typing, and add a richer inspector pane.",
      },
    },
    {
      delayMs: 150,
      kind: "timeline",
      turnId: refactorTurnId,
      item: {
        kind: "reasoning",
        text: "The current UI contract is mostly right. The main issue is exact optional typing in the projection helpers and weak inspector coverage.",
      },
    },
    {
      delayMs: 220,
      kind: "tool_started",
      turnId: refactorTurnId,
      toolCall: {
        id: "tool-typecheck",
        family: "shell",
        providerToolName: "exec_command_end",
        title: "Run TypeScript check",
        input: {
          command: "npm run typecheck",
        },
        detail: {
          artifacts: [
            {
              kind: "command",
              command: "npm run typecheck",
              cwd: "/workspace/rah",
            },
          ],
        },
      },
    },
    {
      delayMs: 260,
      kind: "pty",
      data:
        "$ npm run typecheck\r\npackages/client-web/src/App.tsx(162,15): error TS2339: Property 'cwd' does not exist ...\r\npackages/client-web/src/types.ts(82,7): error TS2353: Object literal may only specify known properties ...\r\n",
    },
    {
      delayMs: 340,
      kind: "tool_completed",
      turnId: refactorTurnId,
      toolCall: {
        id: "tool-typecheck",
        family: "shell",
        providerToolName: "exec_command_end",
        title: "Run TypeScript check",
        summary: "Type errors isolated to projection helpers and resume request typing.",
        result: {
          exitCode: 2,
        },
        detail: {
          artifacts: [
            {
              kind: "text",
              label: "stderr",
              text:
                "App.tsx: resume request type is too loose\ntypes.ts: helper injects optional turnId incorrectly under exactOptionalPropertyTypes",
            },
          ],
        },
      },
    },
    {
      delayMs: 420,
      kind: "tool_started",
      turnId: refactorTurnId,
      toolCall: {
        id: "tool-patch-types",
        family: "patch",
        providerToolName: "patch_apply_end",
        title: "Refactor feed entry helpers",
        input: {
          files: [
            "/workspace/rah/packages/client-web/src/types.ts",
            "/workspace/rah/packages/client-web/src/App.tsx",
          ],
        },
        detail: {
          artifacts: [
            {
              kind: "diff",
              format: "unified",
              text:
                "@@ -67,7 +67,39 @@\n-function withOptionalTurnId<T extends { turnId?: string }>(entry: T, turnId?: string): T {\n+function createTimelineEntry(...)\n+function createToolCallEntry(...)\n+function createPermissionEntry(...)\n@@ -147,3 +148,3 @@\n-const request = {\n+const request: ResumeSessionRequest = {\n",
            },
            {
              kind: "file_refs",
              files: [
                "/workspace/rah/packages/client-web/src/types.ts",
                "/workspace/rah/packages/client-web/src/App.tsx",
              ],
            },
          ],
        },
      },
    },
    {
      delayMs: 470,
      kind: "pty",
      data:
        "Applied patch to packages/client-web/src/types.ts\r\nApplied patch to packages/client-web/src/App.tsx\r\n",
    },
    {
      delayMs: 560,
      kind: "tool_completed",
      turnId: refactorTurnId,
      toolCall: {
        id: "tool-patch-types",
        family: "patch",
        providerToolName: "patch_apply_end",
        title: "Refactor feed entry helpers",
        summary: "Replaced the generic optional-turn helper with explicit constructors and tightened resume typing.",
        result: {
          success: true,
        },
        detail: {
          artifacts: [
            {
              kind: "text",
              label: "stdout",
              text:
                "Success. Updated the following files:\nM packages/client-web/src/types.ts\nM packages/client-web/src/App.tsx",
            },
          ],
        },
      },
    },
    {
      delayMs: 640,
      kind: "tool_started",
      turnId: refactorTurnId,
      toolCall: {
        id: "tool-patch-inspector",
        family: "patch",
        providerToolName: "patch_apply_end",
        title: "Add inspector pane",
        input: {
          files: [
            "/workspace/rah/packages/client-web/src/InspectorPane.tsx",
            "/workspace/rah/packages/client-web/src/FeedView.tsx",
            "/workspace/rah/packages/client-web/src/styles.css",
          ],
        },
        detail: {
          artifacts: [
            {
              kind: "diff",
              format: "unified",
              text:
                "@@ +1,220 @@\n+export function InspectorPane(...) {\n+  // Files / Changes / Events tabs\n+}\n@@\n+.workbench-grid {\n+  grid-template-columns: minmax(320px, 0.9fr) minmax(420px, 1.05fr) minmax(320px, 0.95fr);\n+}\n",
            },
          ],
        },
      },
    },
    {
      delayMs: 690,
      kind: "pty",
      data:
        "Added packages/client-web/src/InspectorPane.tsx\r\nUpdated FeedView.tsx and styles.css\r\n",
    },
    {
      delayMs: 760,
      kind: "tool_completed",
      turnId: refactorTurnId,
      toolCall: {
        id: "tool-patch-inspector",
        family: "patch",
        providerToolName: "patch_apply_end",
        title: "Add inspector pane",
        summary: "Added a three-tab inspector for files, git changes, and raw events.",
        result: {
          success: true,
        },
        detail: {
          artifacts: [
            {
              kind: "text",
              label: "stdout",
              text:
                "Success. Updated the following files:\nA packages/client-web/src/InspectorPane.tsx\nM packages/client-web/src/FeedView.tsx\nM packages/client-web/src/styles.css",
            },
          ],
        },
      },
    },
    {
      delayMs: 860,
      kind: "tool_started",
      turnId: refactorTurnId,
      toolCall: {
        id: "tool-build",
        family: "shell",
        providerToolName: "exec_command_end",
        title: "Build client-web",
        input: {
          command: "npm run build:web",
        },
        detail: {
          artifacts: [
            {
              kind: "command",
              command: "npm run build:web",
              cwd: "/workspace/rah",
            },
          ],
        },
      },
    },
    {
      delayMs: 910,
      kind: "pty",
      data:
        "$ npm run build:web\r\nvite v7.3.2 building client environment for production...\r\n✓ 39 modules transformed.\r\ndist/assets/index.js   507.08 kB │ gzip: 138.42 kB\r\n(!) Some chunks are larger than 500 kB after minification.\r\n✓ built in 501ms\r\n",
    },
    {
      delayMs: 1010,
      kind: "tool_completed",
      turnId: refactorTurnId,
      toolCall: {
        id: "tool-build",
        family: "shell",
        providerToolName: "exec_command_end",
        title: "Build client-web",
        summary: "Build passed. The only remaining issue is a bundle-size warning.",
        result: {
          exitCode: 0,
        },
        detail: {
          artifacts: [
            {
              kind: "text",
              label: "stdout",
              text:
                "dist/index.html 0.39 kB\ndist/assets/index.css 9.96 kB\ndist/assets/index.js 507.08 kB\nWarning: chunk larger than 500 kB after minification.",
            },
          ],
        },
      },
    },
    {
      delayMs: 1080,
      kind: "timeline",
      turnId: refactorTurnId,
      item: {
        kind: "assistant_message",
        text:
          "Projection helpers are now type-safe under exact optional properties, the inspector pane is in place, and the web build passes. Remaining follow-up is chunk splitting, not correctness.",
      },
    },
    {
      delayMs: 1120,
      kind: "usage",
      turnId: refactorTurnId,
      usage: {
        usedTokens: 18420,
        contextWindow: 1_000_000,
        percentRemaining: 98,
      },
    },
    {
      delayMs: 1180,
      kind: "turn_completed",
      turnId: refactorTurnId,
      usage: {
        usedTokens: 18420,
        contextWindow: 1_000_000,
        percentRemaining: 98,
      },
    },
    {
      delayMs: 1210,
      kind: "attention",
      reason: "turn_finished",
      title: "Refactor turn finished",
      body: "The client-web refactor scenario completed successfully.",
      dedupeKey: "scenario:codex-rah-refactor:turn-finished",
    },
    {
      delayMs: 1220,
      kind: "pty",
      data: "$ ",
    },
  ],
};

const permissionScenario: DebugScenario = {
  id: "permission-gate",
  label: "Permission request and resolution",
  description:
    "Synthetic scenario focused on how the UI presents approvals, details, and resolution state transitions.",
  provider: "claude",
  cwd: "/workspace/service-api",
  rootDir: "/workspace/service-api",
  title: "Review destructive shell command",
  preview: "Permission request flow with command details and user resolution.",
  steps: [
    { delayMs: 60, kind: "turn_started", turnId: permissionTurnId },
    {
      delayMs: 90,
      kind: "timeline",
      turnId: permissionTurnId,
      item: {
        kind: "user_message",
        text: "Clean stale generated artifacts and rerun tests.",
      },
    },
    {
      delayMs: 140,
      kind: "timeline",
      turnId: permissionTurnId,
      item: {
        kind: "reasoning",
        text:
          "The requested cleanup touches generated files outside the normal writable roots, so approval is required before proceeding.",
      },
    },
    {
      delayMs: 210,
      kind: "permission_requested",
      turnId: permissionTurnId,
      request: {
        id: "perm-cleanup",
        kind: "tool",
        title: "Allow cleanup command",
        description: "The agent wants to remove generated artifacts and rerun the test suite.",
        detail: {
          artifacts: [
            {
              kind: "command",
              command: "npm run test:runtime",
              cwd: "/workspace/service-api",
            },
            {
              kind: "file_refs",
              files: ["/workspace/service-api/dist", "/workspace/service-api/coverage"],
            },
          ],
        },
        actions: [
          { id: "allow-once", label: "Allow once", behavior: "allow", variant: "primary" },
          { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
        ],
      },
    },
    {
      delayMs: 240,
      kind: "attention",
      reason: "permission_needed",
      title: "Permission required",
      body: "A shell cleanup command is waiting for user approval.",
      dedupeKey: "scenario:permission-gate:approval",
      level: "warning",
    },
    {
      delayMs: 560,
      kind: "permission_resolved",
      turnId: permissionTurnId,
      resolution: {
        requestId: "perm-cleanup",
        behavior: "allow",
        message: "Approved from mobile client.",
      },
    },
    {
      delayMs: 620,
      kind: "tool_started",
      turnId: permissionTurnId,
      toolCall: {
        id: "tool-cleanup",
        family: "shell",
        providerToolName: "shell.cleanup",
        title: "Run cleanup and test suite",
        detail: {
          artifacts: [
            {
              kind: "command",
              command: "npm run test:runtime",
              cwd: "/workspace/service-api",
            },
          ],
        },
      },
    },
    {
      delayMs: 690,
      kind: "pty",
      data: "$ npm run test:runtime\r\n… test output elided …\r\n",
    },
    {
      delayMs: 860,
      kind: "tool_completed",
      turnId: permissionTurnId,
      toolCall: {
        id: "tool-cleanup",
        family: "shell",
        providerToolName: "shell.cleanup",
        title: "Run cleanup and test suite",
        summary: "Cleanup completed and tests passed.",
        result: { exitCode: 0 },
        detail: {
          artifacts: [
            {
              kind: "text",
              label: "stdout",
              text: "Removed dist and coverage.\n42 tests passed.",
            },
          ],
        },
      },
    },
    {
      delayMs: 940,
      kind: "timeline",
      turnId: permissionTurnId,
      item: {
        kind: "assistant_message",
        text: "Cleanup succeeded and the test suite passed after approval.",
      },
    },
    { delayMs: 1010, kind: "turn_completed", turnId: permissionTurnId },
    {
      delayMs: 1040,
      kind: "attention",
      reason: "turn_finished",
      title: "Approved turn finished",
      body: "The approved cleanup workflow completed successfully.",
      dedupeKey: "scenario:permission-gate:turn-finished",
    },
    { delayMs: 1060, kind: "pty", data: "$ " },
  ],
};

const structuredUiScenario: DebugScenario = {
  id: "structured-ui-super-set",
  label: "RAH: structured UI super-set",
  description:
    "Exercises the full hapi/paseo-style structured feed plus RAH message parts, tool deltas, operations, runtime status, and notifications.",
  provider: "codex",
  cwd: "/workspace/rah",
  rootDir: "/workspace/rah",
  title: "Structured Activity Feed Acceptance",
  preview: "Validate every structured card rendered by the Activity feed.",
  steps: [
    { delayMs: 40, kind: "turn_started", turnId: structuredTurnId },
    {
      delayMs: 70,
      kind: "timeline",
      turnId: structuredTurnId,
      item: { kind: "user_message", text: "Show me the structured activity feed." },
    },
    {
      delayMs: 100,
      kind: "message_part_delta",
      turnId: structuredTurnId,
      part: {
        messageId: "assistant-structured-1",
        partId: "assistant-structured-1:text",
        kind: "text",
        delta: "Inspecting ",
      },
    },
    {
      delayMs: 130,
      kind: "message_part_delta",
      turnId: structuredTurnId,
      part: {
        messageId: "assistant-structured-1",
        partId: "assistant-structured-1:text",
        kind: "text",
        delta: "the workspace.",
      },
    },
    {
      delayMs: 160,
      kind: "message_part_added",
      turnId: structuredTurnId,
      part: {
        messageId: "reasoning-structured-1",
        partId: "reasoning-structured-1:summary",
        kind: "reasoning",
        text: "Need to read package metadata, search for adapter tests, and verify runtime output.",
      },
    },
    {
      delayMs: 175,
      kind: "message_part_added",
      turnId: structuredTurnId,
      part: {
        messageId: "file-part-structured-1",
        partId: "file-part-structured-1:package-json",
        kind: "file",
        text: "package.json",
        metadata: { path: "package.json", role: "context" },
      },
    },
    {
      delayMs: 200,
      kind: "runtime_status",
      turnId: structuredTurnId,
      status: "retrying",
      detail: "Transient provider stream retry; no user action required.",
      retryCount: 1,
    },
    {
      delayMs: 240,
      kind: "tool_started",
      turnId: structuredTurnId,
      toolCall: {
        id: "tool-read-package",
        family: "file_read",
        providerToolName: "exec_command",
        title: "Read package.json",
        input: { command: "cat package.json" },
        detail: {
          artifacts: [{ kind: "command", command: "cat package.json", cwd: "/workspace/rah" }],
        },
      },
    },
    {
      delayMs: 270,
      kind: "tool_delta",
      turnId: structuredTurnId,
      toolCallId: "tool-read-package",
      detail: {
        artifacts: [{ kind: "text", label: "stdout", text: "{ \"name\": \"rah\" }" }],
      },
    },
    {
      delayMs: 300,
      kind: "observation_started",
      turnId: structuredTurnId,
      observation: {
        id: "obs-read-package",
        kind: "file.read",
        status: "running",
        title: "Read package.json",
        subject: { command: "cat package.json", cwd: "/workspace/rah", files: ["package.json"] },
      },
    },
    {
      delayMs: 330,
      kind: "observation_completed",
      turnId: structuredTurnId,
      observation: {
        id: "obs-read-package",
        kind: "file.read",
        status: "completed",
        title: "Read package.json",
        subject: { command: "cat package.json", cwd: "/workspace/rah", files: ["package.json"] },
        detail: {
          artifacts: [{ kind: "text", label: "output", text: "{ \"name\": \"rah\" }" }],
        },
        exitCode: 0,
      },
    },
    {
      delayMs: 360,
      kind: "tool_completed",
      turnId: structuredTurnId,
      toolCall: {
        id: "tool-read-package",
        family: "file_read",
        providerToolName: "exec_command",
        title: "Read package.json",
        result: { exitCode: 0 },
        detail: {
          artifacts: [
            { kind: "command", command: "cat package.json", cwd: "/workspace/rah" },
            { kind: "text", label: "stdout", text: "{ \"name\": \"rah\" }" },
          ],
        },
      },
    },
    {
      delayMs: 410,
      kind: "operation_started",
      turnId: structuredTurnId,
      operation: {
        id: "operation-hook-1",
        kind: "automation",
        name: "pre-tool hook",
        target: "exec_command",
      },
    },
    {
      delayMs: 450,
      kind: "operation_resolved",
      turnId: structuredTurnId,
      operation: {
        id: "operation-hook-1",
        kind: "automation",
        name: "pre-tool hook",
        target: "exec_command",
        action: "allow",
        durationMs: 24,
      },
    },
    {
      delayMs: 500,
      kind: "permission_requested",
      turnId: structuredTurnId,
      request: {
        id: "perm-structured-command",
        kind: "tool",
        title: "Allow test command",
        description: "Run a safe verification command.",
        detail: {
          artifacts: [{ kind: "command", command: "npm run test:runtime", cwd: "/workspace/rah" }],
        },
        actions: [
          { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
          { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
        ],
      },
    },
    {
      delayMs: 520,
      kind: "attention",
      reason: "permission_needed",
      title: "Permission required",
      body: "A verification command is waiting for approval.",
      dedupeKey: "scenario:structured-ui:permission",
      level: "warning",
    },
    {
      delayMs: 650,
      kind: "permission_resolved",
      turnId: structuredTurnId,
      resolution: {
        requestId: "perm-structured-command",
        behavior: "allow",
        message: "Approved for scenario.",
      },
    },
    {
      delayMs: 680,
      kind: "attention_cleared",
      turnId: structuredTurnId,
      id: "attention-permission-perm-structured-command",
    },
    {
      delayMs: 720,
      kind: "notification",
      turnId: structuredTurnId,
      level: "info",
      title: "Structured feed notice",
      body: "Infrastructure notifications render outside the transcript stream.",
      url: "https://example.test/rah",
    },
    {
      delayMs: 735,
      kind: "tool_completed",
      turnId: structuredTurnId,
      toolCall: {
        id: "tool-patch-diff",
        family: "patch",
        providerToolName: "fileChange",
        title: "Apply file changes",
        summary: "src/feed.tsx",
        detail: {
          artifacts: [
            { kind: "file_refs", files: ["src/feed.tsx"] },
            { kind: "diff", format: "unified", text: "diff --git a/src/feed.tsx b/src/feed.tsx\n@@ -1,2 +1,2 @@\n-raw patch output\n+structured diff output" },
          ],
        },
        result: { success: true },
      },
    },
    {
      delayMs: 750,
      kind: "tool_completed",
      turnId: structuredTurnId,
      toolCall: {
        id: "tool-mcp-result",
        family: "mcp",
        providerToolName: "filesystem.read_file",
        title: "filesystem: read_file",
        detail: {
          artifacts: [
            { kind: "json", label: "arguments", value: { path: "README.md" } },
            { kind: "json", label: "result", value: { content: [{ type: "text", text: "README excerpt from MCP result." }] } },
          ],
        },
        result: { content: [{ type: "text", text: "README excerpt from MCP result." }] },
      },
    },
    {
      delayMs: 765,
      kind: "permission_requested",
      turnId: structuredTurnId,
      request: {
        id: "perm-structured-question",
        kind: "question",
        title: "Clarify target",
        description: "The agent needs one structured answer before proceeding.",
        input: {
          questions: [
            {
              id: "target",
              header: "Target",
              question: "Which area should the agent inspect next?",
              options: [
                { label: "Protocol", description: "Review backend event contract." },
                { label: "UI", description: "Review frontend render behavior." },
              ],
            },
          ],
        },
        actions: [
          { id: "submit", label: "Submit", behavior: "allow", variant: "primary" },
          { id: "deny", label: "Dismiss", behavior: "deny", variant: "danger" },
        ],
      },
    },
    {
      delayMs: 780,
      kind: "observation_failed",
      turnId: structuredTurnId,
      observation: {
        id: "obs-failed-test",
        kind: "test.run",
        status: "failed",
        title: "Run tests",
        subject: { command: "npm run test:runtime" },
        detail: { artifacts: [{ kind: "text", label: "stderr", text: "1 failing fixture" }] },
        exitCode: 1,
      },
      error: "1 failing fixture",
    },
    {
      delayMs: 820,
      kind: "attention",
      reason: "turn_failed",
      title: "Test verification failed",
      body: "The structured UI scenario includes a failing observation card.",
      dedupeKey: "scenario:structured-ui:failed-observation",
      level: "critical",
    },
    {
      delayMs: 900,
      kind: "timeline",
      turnId: structuredTurnId,
      item: {
        kind: "assistant_message",
        text: "The Activity feed now includes message parts, tool deltas, observations, permissions, attention, operations, runtime status, and notifications.",
      },
    },
    {
      delayMs: 940,
      kind: "usage",
      turnId: structuredTurnId,
      usage: { usedTokens: 4200, contextWindow: 1000000, percentRemaining: 99 },
    },
    { delayMs: 980, kind: "turn_completed", turnId: structuredTurnId },
  ],
};

export const DEBUG_SCENARIOS: DebugScenario[] = [
  codexRefactorScenario,
  permissionScenario,
  structuredUiScenario,
];
