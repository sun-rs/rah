import type { SessionModeDescriptor, SessionSummary } from "@rah/runtime-protocol";
import type { ProviderChoice } from "./components/ProviderSelector";

export type SessionModeChoice = {
  id: string;
  label: string;
  description?: string;
};

export type SessionModeDraft = {
  accessModeId: string | null;
  planEnabled: boolean;
};

export type SessionModeControlState = {
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  effectiveModeId: string | null;
};

type SupportedModeProvider = ProviderChoice | "custom";

type ProviderPreset = {
  accessModes: SessionModeChoice[];
  defaultAccessModeId: string | null;
  planModeAvailable: boolean;
};

const PROVIDER_MODE_PRESETS: Record<SupportedModeProvider, ProviderPreset> = {
  codex: {
    accessModes: [
      {
        id: "on-request/workspace-write",
        label: "Default",
        description: "Ask for approvals, allow workspace edits.",
      },
      {
        id: "on-request/read-only",
        label: "Read only",
        description: "Ask for approvals, keep the sandbox read-only.",
      },
      {
        id: "never/danger-full-access",
        label: "Full auto",
        description: "Skip approvals and allow unrestricted access.",
      },
    ],
    defaultAccessModeId: "on-request/workspace-write",
    planModeAvailable: true,
  },
  claude: {
    accessModes: [
      { id: "default", label: "Default", description: "Standard permission prompts." },
      {
        id: "acceptEdits",
        label: "Auto edit",
        description: "Auto-accept edits while keeping stricter prompts for riskier actions.",
      },
      {
        id: "bypassPermissions",
        label: "Full auto",
        description: "Skip permission prompts for all actions.",
      },
      {
        id: "dontAsk",
        label: "Don't ask",
        description: "Refuse unapproved actions instead of prompting.",
      },
    ],
    defaultAccessModeId: "default",
    planModeAvailable: true,
  },
  gemini: {
    accessModes: [
      { id: "default", label: "Default", description: "Normal approval prompts." },
      {
        id: "auto_edit",
        label: "Auto edit",
        description: "Auto-approve edit tools while keeping other prompts.",
      },
      {
        id: "yolo",
        label: "Full auto",
        description: "Auto-approve all actions.",
      },
    ],
    defaultAccessModeId: "default",
    planModeAvailable: true,
  },
  kimi: {
    accessModes: [],
    defaultAccessModeId: null,
    planModeAvailable: true,
  },
  opencode: {
    accessModes: [],
    defaultAccessModeId: null,
    planModeAvailable: false,
  },
  custom: {
    accessModes: [],
    defaultAccessModeId: null,
    planModeAvailable: false,
  },
};

function cloneChoices(choices: readonly SessionModeChoice[]): SessionModeChoice[] {
  return choices.map((choice) => ({ ...choice }));
}

function extractPlanDescriptor(
  availableModes: readonly SessionModeDescriptor[],
): SessionModeDescriptor | null {
  return availableModes.find((mode) => mode.id === "plan") ?? null;
}

function extractAccessModes(
  availableModes: readonly SessionModeDescriptor[],
): SessionModeChoice[] {
  return availableModes
    .filter((mode) => mode.id !== "plan")
    .map((mode) => ({
      id: mode.id,
      label: mode.label,
      ...(mode.description ? { description: mode.description } : {}),
    }));
}

function resolvePreset(provider: SupportedModeProvider): ProviderPreset {
  return PROVIDER_MODE_PRESETS[provider];
}

export function createDefaultModeDraft(provider: SupportedModeProvider): SessionModeDraft {
  const preset = resolvePreset(provider);
  return {
    accessModeId: preset.defaultAccessModeId,
    planEnabled: false,
  };
}

export function resolveSessionModeControlState(args: {
  provider: SupportedModeProvider;
  draft?: SessionModeDraft | null;
  summary?: SessionSummary | null;
}): SessionModeControlState {
  const preset = resolvePreset(args.provider);
  if (args.summary?.session.mode) {
    const availableModes = args.summary.session.mode.availableModes;
    const accessModes = extractAccessModes(availableModes);
    const planMode = extractPlanDescriptor(availableModes);
    const currentModeId = args.summary.session.mode.currentModeId;
    const selectedAccessModeId =
      currentModeId && currentModeId !== "plan"
        ? currentModeId
        : args.draft?.accessModeId ?? accessModes[0]?.id ?? preset.defaultAccessModeId;
    const planEnabled =
      currentModeId === "plan"
        ? true
        : args.draft?.planEnabled ?? false;
    return {
      accessModes,
      selectedAccessModeId,
      planModeAvailable: preset.planModeAvailable || Boolean(planMode),
      planModeEnabled: planEnabled,
      effectiveModeId: planEnabled ? "plan" : selectedAccessModeId,
    };
  }
  const selectedAccessModeId = args.draft?.accessModeId ?? preset.defaultAccessModeId;
  const planModeEnabled = preset.planModeAvailable ? (args.draft?.planEnabled ?? false) : false;
  return {
    accessModes: cloneChoices(preset.accessModes),
    selectedAccessModeId,
    planModeAvailable: preset.planModeAvailable,
    planModeEnabled,
    effectiveModeId: planModeEnabled ? "plan" : selectedAccessModeId,
  };
}
