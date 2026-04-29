import type {
  ProviderKind,
  SessionModeDescriptor,
  SessionModeState,
} from "@rah/runtime-protocol";

const CLAUDE_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "default",
    role: "ask",
    label: "Ask",
    description: "Ask before actions that need approval.",
    applyTiming: "immediate",
    hotSwitch: true,
  },
  {
    id: "acceptEdits",
    role: "auto_edit",
    label: "Auto edit",
    description: "Auto-accept file edits while still prompting for riskier actions.",
    applyTiming: "immediate",
    hotSwitch: true,
  },
  {
    id: "plan",
    role: "plan",
    label: "Plan",
    description: "Read-only planning mode.",
    applyTiming: "immediate",
    hotSwitch: true,
  },
  {
    id: "bypassPermissions",
    role: "full_auto",
    label: "Full auto",
    description: "Skip permission prompts for all actions.",
    applyTiming: "immediate",
    hotSwitch: true,
  },
];

const GEMINI_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "default",
    role: "ask",
    label: "Ask",
    description: "Ask before actions that need approval.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "auto_edit",
    role: "auto_edit",
    label: "Auto edit",
    description: "Auto-approve edit tools while keeping stricter approval for other actions.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "plan",
    role: "plan",
    label: "Plan",
    description: "Read-only planning mode.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "yolo",
    role: "full_auto",
    label: "Full auto",
    description: "Auto-approve all actions.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
];

const KIMI_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "default",
    role: "ask",
    label: "Ask",
    description: "Ask before actions that need approval.",
    applyTiming: "idle_only",
    hotSwitch: true,
  },
  {
    id: "plan",
    role: "plan",
    label: "Plan",
    description: "Read-only planning mode.",
    applyTiming: "idle_only",
    hotSwitch: true,
  },
  {
    id: "yolo",
    role: "full_auto",
    label: "Full auto",
    description: "Auto-approve all actions.",
    applyTiming: "idle_only",
    hotSwitch: true,
  },
];

const OPENCODE_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "build",
    role: "ask",
    label: "Ask",
    description: "Use OpenCode build mode and ask before tool actions.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "opencode/full-auto",
    role: "full_auto",
    label: "Full auto",
    description: "Allow common OpenCode tool permissions for this session.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "plan",
    role: "plan",
    label: "Plan",
    description: "OpenCode plan mode. Edit tools are disabled by the provider.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
];

const CODEX_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "on-request/read-only",
    role: "ask",
    label: "Ask",
    description: "Ask before write or shell actions; Codex starts with a read-only sandbox.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "on-request/workspace-write",
    role: "auto_edit",
    label: "Auto edit",
    description: "Codex low-friction mode: workspace-write sandbox, ask before leaving it.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "never/workspace-write",
    role: "full_auto",
    label: "Full auto · sandboxed",
    description: "Skip approvals while keeping Codex inside the workspace sandbox.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
  {
    id: "never/danger-full-access",
    role: "full_auto",
    label: "Full auto",
    description: "Skip approvals and allow unrestricted access.",
    applyTiming: "next_turn",
    hotSwitch: true,
  },
];

const CODEX_PLAN_MODE_DESCRIPTOR: SessionModeDescriptor = {
  id: "plan",
  role: "plan",
  label: "Plan",
  description: "Codex plan collaboration mode.",
  applyTiming: "next_turn",
  hotSwitch: true,
};

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
}): SessionModeState {
  return buildModeState({
    currentModeId: args.currentModeId,
    availableModes: CLAUDE_MODE_DESCRIPTORS,
    mutable: args.mutable,
    source: args.source ?? "native",
  });
}

export function isClaudeModeId(modeId: string): boolean {
  return CLAUDE_MODE_DESCRIPTORS.some((mode) => mode.id === modeId);
}

export function buildGeminiModeState(args: {
  currentModeId: string;
  mutable: boolean;
  source?: SessionModeState["source"];
}): SessionModeState {
  return buildModeState({
    currentModeId: args.currentModeId,
    availableModes: GEMINI_MODE_DESCRIPTORS,
    mutable: args.mutable,
    source: args.source ?? "native",
  });
}

export function isGeminiModeId(modeId: string): boolean {
  return GEMINI_MODE_DESCRIPTORS.some((mode) => mode.id === modeId);
}

export function buildKimiModeState(args: {
  currentModeId: string;
  mutable: boolean;
  source?: SessionModeState["source"];
}): SessionModeState {
  return buildModeState({
    currentModeId: args.currentModeId,
    availableModes: KIMI_MODE_DESCRIPTORS,
    mutable: args.mutable,
    source: args.source ?? "native",
  });
}

export function isKimiModeId(modeId: string): boolean {
  return KIMI_MODE_DESCRIPTORS.some((mode) => mode.id === modeId);
}

export function buildOpenCodeModeState(args: {
  currentModeId: string;
  mutable: boolean;
  source?: SessionModeState["source"];
}): SessionModeState {
  return buildModeState({
    currentModeId: args.currentModeId,
    availableModes: OPENCODE_MODE_DESCRIPTORS,
    mutable: args.mutable,
    source: args.source ?? "native",
  });
}

export function isOpenCodeModeId(modeId: string): boolean {
  return OPENCODE_MODE_DESCRIPTORS.some((mode) => mode.id === modeId);
}

export function defaultProviderModeId(provider: ProviderKind): string | null {
  switch (provider) {
    case "codex":
      return "never/danger-full-access";
    case "claude":
      return "bypassPermissions";
    case "gemini":
      return "yolo";
    case "kimi":
      return "yolo";
    case "opencode":
      return "opencode/full-auto";
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
        planAvailable: options?.planAvailable ?? true,
      }).availableModes;
    case "claude":
      return cloneDescriptors(CLAUDE_MODE_DESCRIPTORS);
    case "gemini":
      return cloneDescriptors(GEMINI_MODE_DESCRIPTORS);
    case "kimi":
      return cloneDescriptors(KIMI_MODE_DESCRIPTORS);
    case "opencode":
      return cloneDescriptors(OPENCODE_MODE_DESCRIPTORS);
    case "custom":
    default:
      return [];
  }
}

function codexModeDescriptor(modeId: string): SessionModeDescriptor {
  const [approvalPolicy, sandboxMode] = modeId.split("/", 2);
  return {
    id: modeId,
    role: "custom",
    label: `${approvalPolicy} · ${sandboxMode}`,
    description: "Current Codex approval and sandbox configuration.",
    applyTiming: "next_turn",
    hotSwitch: true,
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
} | null {
  const parts = modeId.split("/", 2);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return {
    approvalPolicy: parts[0],
    sandboxMode: parts[1],
  };
}

export function isCodexModeId(modeId: string): boolean {
  return modeId === "plan" || CODEX_MODE_DESCRIPTORS.some((mode) => mode.id === modeId);
}
