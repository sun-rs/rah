import type {
  ProviderKind,
  SessionModeDescriptor,
  SessionModeState,
} from "@rah/runtime-protocol";

const CLAUDE_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "default",
    role: "ask",
    label: "Default",
    description: "Claude default permission mode.",
    applyTiming: "startup_only",
    hotSwitch: false,
  },
  {
    id: "acceptEdits",
    role: "auto_edit",
    label: "Accept Edits",
    description: "Auto-accept file edits while still prompting for riskier actions.",
    applyTiming: "startup_only",
    hotSwitch: false,
  },
  {
    id: "plan",
    role: "plan",
    label: "Plan",
    description: "Read-only planning mode.",
    applyTiming: "startup_only",
    hotSwitch: false,
  },
  {
    id: "bypassPermissions",
    role: "full_auto",
    label: "Bypass Permissions",
    description: "Skip permission prompts for all actions.",
    applyTiming: "startup_only",
    hotSwitch: false,
  },
];

const OPENCODE_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "build",
    role: "custom",
    label: "Build",
    description: "Use OpenCode's build agent.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "plan",
    role: "custom",
    label: "Plan",
    description: "Use OpenCode's plan agent. Edit tools are disabled by the provider.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
];

const CODEX_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "on-request/workspace-write",
    role: "ask",
    label: "Default",
    description: "Codex default preset: workspace-write sandbox, ask before leaving it.",
    applyTiming: "startup_only",
    hotSwitch: false,
  },
  {
    id: "auto-review/workspace-write",
    role: "auto_edit",
    label: "Auto Review",
    description: "Use Codex auto-review for approval requests while keeping the workspace sandbox.",
    applyTiming: "startup_only",
    hotSwitch: false,
  },
  {
    id: "never/danger-full-access",
    role: "full_auto",
    label: "Full Access",
    description: "Skip approvals and allow unrestricted access.",
    applyTiming: "startup_only",
    hotSwitch: false,
  },
];

const CODEX_PLAN_MODE_DESCRIPTOR: SessionModeDescriptor = {
  id: "plan",
  role: "plan",
  label: "Plan",
  description: "Codex plan collaboration mode.",
  applyTiming: "startup_only",
  hotSwitch: false,
};
const CODEX_PLAN_MODE_ID_PREFIX = "plan:";
const CODEX_APPROVAL_POLICIES = new Set([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

function cloneDescriptor(descriptor: SessionModeDescriptor): SessionModeDescriptor {
  return {
    ...descriptor,
  };
}

function cloneDescriptors(
  descriptors: readonly SessionModeDescriptor[],
): SessionModeDescriptor[] {
  return descriptors.map(cloneDescriptor);
}

function buildModeState(args: {
  currentModeId: string | null;
  availableModes: readonly SessionModeDescriptor[];
  mutable: boolean;
  source: SessionModeState["source"];
}): SessionModeState {
  return {
    currentModeId: args.currentModeId,
    availableModes: cloneDescriptors(args.availableModes),
    mutable: args.mutable,
    source: args.source,
  };
}

export function buildExternalLockedModeState(): SessionModeState {
  return {
    currentModeId: null,
    availableModes: [],
    mutable: false,
    source: "external_locked",
  };
}

export function buildClaudeModeState(args: {
  currentModeId: string;
  mutable: boolean;
  source?: SessionModeState["source"];
  availableModes?: readonly SessionModeDescriptor[];
}): SessionModeState {
  return buildModeState({
    currentModeId: args.currentModeId,
    availableModes: args.availableModes ?? CLAUDE_MODE_DESCRIPTORS,
    mutable: args.mutable,
    source: args.source ?? "native",
  });
}

export function isClaudeModeId(modeId: string): boolean {
  return CLAUDE_MODE_DESCRIPTORS.some((mode) => mode.id === modeId);
}

const CLAUDE_PRIMARY_MODE_ORDER = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];
const CLAUDE_HIDDEN_MODE_IDS = new Set(["auto", "dontAsk"]);

export function parseClaudePermissionModeChoices(helpText: string): string[] {
  const permissionIndex = helpText.indexOf("--permission-mode");
  if (permissionIndex < 0) {
    return [];
  }
  const relevantHelp = helpText.slice(permissionIndex, permissionIndex + 800);
  const choicesIndex = relevantHelp.toLowerCase().indexOf("choices:");
  if (choicesIndex < 0) {
    return [];
  }
  const choiceText = relevantHelp.slice(choicesIndex, choicesIndex + 400);
  return [...choiceText.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]?.trim())
    .filter((choice): choice is string => Boolean(choice));
}

export function buildClaudeModeDescriptorsFromChoices(
  choices: readonly string[],
): SessionModeDescriptor[] {
  const choiceSet = new Set(choices.map((choice) => choice.trim()).filter(Boolean));
  const descriptors = CLAUDE_PRIMARY_MODE_ORDER.flatMap((modeId) => {
    if (choiceSet.size > 0 && !choiceSet.has(modeId)) {
      return [];
    }
    const descriptor = CLAUDE_MODE_DESCRIPTORS.find((mode) => mode.id === modeId);
    return descriptor ? [cloneDescriptor(descriptor)] : [];
  });
  if (descriptors.length > 0) {
    return descriptors;
  }
  return cloneDescriptors(CLAUDE_MODE_DESCRIPTORS);
}

export function buildClaudeModeDescriptorsFromHelp(helpText: string): SessionModeDescriptor[] {
  const choices = parseClaudePermissionModeChoices(helpText).filter(
    (choice) => !CLAUDE_HIDDEN_MODE_IDS.has(choice),
  );
  return buildClaudeModeDescriptorsFromChoices(choices);
}

export function buildOpenCodeModeState(args: {
  currentModeId: string;
  mutable: boolean;
  source?: SessionModeState["source"];
  availableModes?: readonly SessionModeDescriptor[];
}): SessionModeState {
  const availableModes = ensureDescriptorForCurrentMode(
    args.availableModes ?? OPENCODE_MODE_DESCRIPTORS,
    args.currentModeId,
    openCodeAgentDescriptor,
  );
  return buildModeState({
    currentModeId: args.currentModeId,
    availableModes,
    mutable: args.mutable,
    source: args.source ?? "native",
  });
}

function openCodeAgentDescriptor(modeId: string): SessionModeDescriptor {
  return {
    id: modeId,
    role: "custom",
    label: humanizeOpenCodeAgentLabel(modeId),
    description: `Use OpenCode agent '${modeId}'.`,
    applyTiming: "next_turn",
    hotSwitch: true,
  };
}

function humanizeOpenCodeAgentLabel(modeId: string): string {
  if (modeId === "build") {
    return "Build";
  }
  if (modeId === "plan") {
    return "Plan";
  }
  return modeId;
}

function ensureDescriptorForCurrentMode(
  descriptors: readonly SessionModeDescriptor[],
  currentModeId: string,
  fallback: (modeId: string) => SessionModeDescriptor,
): SessionModeDescriptor[] {
  const cloned = cloneDescriptors(descriptors);
  if (!cloned.some((mode) => mode.id === currentModeId)) {
    cloned.unshift(fallback(currentModeId));
  }
  return cloned;
}

export function buildOpenCodeAgentModeDescriptors(
  agents: readonly { id: string; label?: string; description?: string }[],
): SessionModeDescriptor[] {
  const seen = new Set<string>();
  const descriptors = agents.flatMap((agent) => {
    const id = agent.id.trim();
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [{
      id,
      role: "custom" as const,
      label: agent.label?.trim() || humanizeOpenCodeAgentLabel(id),
      ...(agent.description?.trim() ? { description: agent.description.trim() } : {}),
      applyTiming: "next_turn" as const,
      hotSwitch: true,
    }];
  });
  return descriptors.length > 0 ? descriptors : cloneDescriptors(OPENCODE_MODE_DESCRIPTORS);
}

export function isOpenCodeModeId(
  modeId: string,
  availableModes?: readonly SessionModeDescriptor[],
): boolean {
  const trimmed = modeId.trim();
  if (!trimmed) {
    return false;
  }
  const descriptors = availableModes ?? OPENCODE_MODE_DESCRIPTORS;
  return descriptors.some((mode) => mode.id === trimmed);
}

export function codexPlanModeId(accessModeId: string): string {
  return `${CODEX_PLAN_MODE_ID_PREFIX}${accessModeId.trim()}`;
}

export function codexPlanAccessModeId(modeId: string): string | null {
  const trimmed = modeId.trim();
  if (!trimmed.startsWith(CODEX_PLAN_MODE_ID_PREFIX)) {
    return null;
  }
  const accessModeId = trimmed.slice(CODEX_PLAN_MODE_ID_PREFIX.length).trim();
  return accessModeId && parseCodexModeId(accessModeId) ? accessModeId : null;
}

export function isCodexPlanModeId(modeId: string): boolean {
  const trimmed = modeId.trim();
  return trimmed === "plan" || codexPlanAccessModeId(trimmed) !== null;
}

export function defaultProviderModeId(provider: ProviderKind): string | null {
  switch (provider) {
    case "codex":
      return "never/danger-full-access";
    case "claude":
      return "bypassPermissions";
    case "opencode":
      return "build";
    case "custom":
    default:
      return null;
  }
}

export function providerModeDescriptors(
  provider: ProviderKind,
  options?: { planAvailable?: boolean },
): SessionModeDescriptor[] {
  switch (provider) {
    case "codex":
      return buildCodexModeState({
        currentModeId: defaultProviderModeId("codex")!,
        mutable: true,
        planAvailable: options?.planAvailable ?? false,
      }).availableModes;
    case "claude":
      return cloneDescriptors(CLAUDE_MODE_DESCRIPTORS);
    case "opencode":
      return cloneDescriptors(OPENCODE_MODE_DESCRIPTORS);
    case "custom":
    default:
      return [];
  }
}

function codexModeDescriptor(modeId: string): SessionModeDescriptor {
  const config = resolveCodexModeConfig(modeId);
  const approvalPolicy = config?.approvalPolicy ?? modeId.split("/", 2)[0] ?? modeId;
  const sandboxMode = config?.sandboxMode ?? modeId.split("/", 2)[1] ?? "unknown";
  return {
    id: modeId,
    role: "custom",
    label: `${approvalPolicy} · ${sandboxMode}`,
    description: "Current Codex approval and sandbox configuration.",
    applyTiming: "startup_only",
    hotSwitch: false,
  };
}

export function buildCodexModeState(args: {
  currentModeId: string;
  mutable: boolean;
  source?: SessionModeState["source"];
  preferredAccessModeId?: string;
  planAvailable?: boolean;
}): SessionModeState {
  const availableModes = cloneDescriptors(CODEX_MODE_DESCRIPTORS);
  if (args.planAvailable || args.currentModeId === "plan") {
    availableModes.splice(1, 0, cloneDescriptor(CODEX_PLAN_MODE_DESCRIPTOR));
  }
  if (args.preferredAccessModeId) {
    const preferredIndex = availableModes.findIndex((mode) => mode.id === args.preferredAccessModeId);
    if (preferredIndex > 0) {
      const [preferred] = availableModes.splice(preferredIndex, 1);
      if (preferred) {
        availableModes.unshift(preferred);
      }
    }
  }
  if (!availableModes.some((mode) => mode.id === args.currentModeId)) {
    availableModes.unshift(codexModeDescriptor(args.currentModeId));
  }
  return {
    currentModeId: args.currentModeId,
    availableModes,
    mutable: args.mutable,
    source: args.source ?? "native",
  };
}

export function codexModeId(args: {
  approvalPolicy: string;
  sandboxMode: string;
}): string {
  return `${args.approvalPolicy}/${args.sandboxMode}`;
}

export function parseCodexModeId(modeId: string): {
  approvalPolicy: string;
  sandboxMode: string;
  approvalsReviewer?: "user" | "auto_review";
} | null {
  const config = resolveCodexModeConfig(modeId);
  if (config) {
    return config;
  }
  const parts = modeId.split("/", 2);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  if (!CODEX_APPROVAL_POLICIES.has(parts[0]) || !CODEX_SANDBOX_MODES.has(parts[1])) {
    return null;
  }
  return {
    approvalPolicy: parts[0],
    sandboxMode: parts[1],
    approvalsReviewer: "user",
  };
}

export function resolveCodexModeConfig(modeId: string): {
  approvalPolicy: string;
  sandboxMode: string;
  approvalsReviewer?: "user" | "auto_review";
} | null {
  switch (modeId) {
    case "on-request/workspace-write":
      return {
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        approvalsReviewer: "user",
      };
    case "auto-review/workspace-write":
      return {
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        approvalsReviewer: "auto_review",
      };
    case "never/danger-full-access":
      return {
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        approvalsReviewer: "user",
      };
    case "on-request/read-only":
      return {
        approvalPolicy: "on-request",
        sandboxMode: "read-only",
        approvalsReviewer: "user",
      };
    case "never/workspace-write":
      return {
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        approvalsReviewer: "user",
      };
    default:
      return null;
  }
}

export function isCodexModeId(modeId: string): boolean {
  return isCodexPlanModeId(modeId) || parseCodexModeId(modeId) !== null;
}
