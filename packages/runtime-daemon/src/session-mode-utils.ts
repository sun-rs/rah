import type { SessionModeDescriptor, SessionModeState } from "@rah/runtime-protocol";

const CLAUDE_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard permission prompts for tool actions.",
    hotSwitch: true,
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    description: "Auto-accept file edits while still prompting for riskier actions.",
    hotSwitch: true,
  },
  {
    id: "bypassPermissions",
    label: "Bypass permissions",
    description: "Skip permission prompts for all actions.",
    hotSwitch: true,
  },
  {
    id: "dontAsk",
    label: "Don't ask",
    description: "Deny actions that are not already approved instead of prompting.",
    hotSwitch: true,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode.",
    hotSwitch: true,
  },
];

const GEMINI_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "default",
    label: "Default",
    description: "Prompt for approval when tools need it.",
    hotSwitch: true,
  },
  {
    id: "auto_edit",
    label: "Auto edit",
    description: "Auto-approve edit tools while keeping stricter approval for other actions.",
    hotSwitch: true,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode.",
    hotSwitch: true,
  },
  {
    id: "yolo",
    label: "YOLO",
    description: "Auto-approve all actions.",
    hotSwitch: true,
  },
];

const KIMI_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard interactive mode.",
    hotSwitch: true,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode.",
    hotSwitch: true,
  },
];

const OPENCODE_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "build",
    label: "Build",
    description: "Default OpenCode agent mode.",
    hotSwitch: true,
  },
  {
    id: "plan",
    label: "Plan",
    description: "OpenCode plan mode. Edit tools are disabled by the provider.",
    hotSwitch: true,
  },
];

const CODEX_MODE_DESCRIPTORS: SessionModeDescriptor[] = [
  {
    id: "on-request/read-only",
    label: "On request · Read only",
    description: "Ask for approvals and keep the sandbox read-only.",
    hotSwitch: true,
  },
  {
    id: "on-request/workspace-write",
    label: "On request · Workspace write",
    description: "Ask for approvals and allow writing inside the workspace.",
    hotSwitch: true,
  },
  {
    id: "never/danger-full-access",
    label: "Never · Danger full access",
    description: "Skip approvals and allow unrestricted access.",
    hotSwitch: true,
  },
];

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

function codexModeDescriptor(modeId: string): SessionModeDescriptor {
  const [approvalPolicy, sandboxMode] = modeId.split("/", 2);
  return {
    id: modeId,
    label: `${approvalPolicy} · ${sandboxMode}`,
    description: "Current Codex approval and sandbox configuration.",
    hotSwitch: true,
  };
}

export function buildCodexModeState(args: {
  currentModeId: string;
  mutable: boolean;
  source?: SessionModeState["source"];
  preferredAccessModeId?: string;
}): SessionModeState {
  const availableModes = cloneDescriptors(CODEX_MODE_DESCRIPTORS);
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
