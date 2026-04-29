import type {
  ProviderModelCatalog,
  SessionModeDescriptor,
  SessionModeRole,
  SessionSummary,
} from "@rah/runtime-protocol";
import type { ProviderChoice } from "./components/ProviderSelector";

export type SessionModeChoice = {
  id: string;
  label: string;
  description?: string;
  applyTiming?: SessionModeDescriptor["applyTiming"];
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

const ROLE_LABELS: Record<Exclude<SessionModeRole, "custom">, string> = {
  ask: "Ask",
  auto_edit: "Auto edit",
  full_auto: "Full auto",
  plan: "Plan",
};

const LEGACY_ACCESS_MODE_LABELS: Record<string, string> = {
  default: "Ask",
  build: "Ask",
  acceptEdits: "Auto edit",
  auto_edit: "Auto edit",
  "on-request/workspace-write": "Auto edit",
  "on-request/read-only": "Ask",
  "never/workspace-write": "Full auto · sandboxed",
  "never/danger-full-access": "Full auto",
  bypassPermissions: "Full auto",
  yolo: "Full auto",
  "opencode/full-auto": "Full auto",
};

function extractPlanDescriptor(
  availableModes: readonly SessionModeDescriptor[],
): SessionModeDescriptor | null {
  return availableModes.find((mode) => mode.role === "plan" || mode.id === "plan") ?? null;
}

function isPlanMode(mode: SessionModeDescriptor): boolean {
  return mode.role === "plan" || mode.id === "plan";
}

function normalizeModeLabel(mode: SessionModeDescriptor): string {
  if (mode.role && mode.role !== "custom") {
    if (mode.role === "full_auto" && mode.label.toLowerCase().includes("sandbox")) {
      return mode.label;
    }
    return ROLE_LABELS[mode.role];
  }
  return LEGACY_ACCESS_MODE_LABELS[mode.id] ?? mode.label ?? mode.id;
}

function extractAccessModes(
  availableModes: readonly SessionModeDescriptor[],
): SessionModeChoice[] {
  return availableModes
    .filter((mode) => !isPlanMode(mode))
    .map((mode) => ({
      id: mode.id,
      label: normalizeModeLabel(mode),
      ...(mode.description ? { description: mode.description } : {}),
      ...(mode.applyTiming ? { applyTiming: mode.applyTiming } : {}),
    }));
}

function resolveDefaultAccessModeId(
  descriptors: readonly SessionModeDescriptor[],
  explicitDefaultModeId: string | null | undefined,
): string | null {
  if (
    explicitDefaultModeId &&
    !descriptors.some((mode) => mode.id === explicitDefaultModeId && isPlanMode(mode))
  ) {
    return explicitDefaultModeId;
  }
  const fullAutoMode = [...descriptors]
    .reverse()
    .find((mode) => mode.role === "full_auto");
  if (fullAutoMode) {
    return fullAutoMode.id;
  }
  const accessModes = extractAccessModes(descriptors);
  return accessModes[accessModes.length - 1]?.id ?? null;
}

function resolveSelectedAccessModeId(args: {
  currentModeId?: string | null | undefined;
  draftModeId?: string | null | undefined;
  defaultModeId?: string | null | undefined;
  accessModes: readonly SessionModeChoice[];
}): string | null {
  const accessModeIds = new Set(args.accessModes.map((mode) => mode.id));
  if (args.currentModeId && accessModeIds.has(args.currentModeId)) {
    return args.currentModeId;
  }
  if (args.draftModeId && accessModeIds.has(args.draftModeId)) {
    return args.draftModeId;
  }
  if (args.defaultModeId && accessModeIds.has(args.defaultModeId)) {
    return args.defaultModeId;
  }
  return args.accessModes[args.accessModes.length - 1]?.id ?? null;
}

export function createDefaultModeDraft(_provider: SupportedModeProvider): SessionModeDraft {
  return {
    accessModeId: null,
    planEnabled: false,
  };
}

export function resolveSessionModeControlState(args: {
  provider: SupportedModeProvider;
  draft?: SessionModeDraft | null;
  summary?: SessionSummary | null;
  catalog?: ProviderModelCatalog | null;
}): SessionModeControlState {
  void args.provider;
  const catalogDescriptors = args.catalog?.modes ?? [];
  if (args.summary?.session.mode) {
    const descriptors =
      args.summary.session.mode.availableModes.length > 0
        ? args.summary.session.mode.availableModes
        : catalogDescriptors;
    const accessModes = extractAccessModes(descriptors);
    const planMode = extractPlanDescriptor(descriptors);
    const planModeAvailable = Boolean(planMode);
    const currentModeId = args.summary.session.mode.currentModeId;
    const defaultAccessModeId = resolveDefaultAccessModeId(
      descriptors,
      args.catalog?.defaultModeId,
    );
    const selectedAccessModeId = resolveSelectedAccessModeId({
      currentModeId,
      draftModeId: args.draft?.accessModeId,
      defaultModeId: defaultAccessModeId,
      accessModes,
    });
    const planEnabled =
      descriptors.some((mode) => mode.id === currentModeId && isPlanMode(mode))
        ? true
        : planModeAvailable && (args.draft?.planEnabled ?? false);
    return {
      accessModes,
      selectedAccessModeId,
      planModeAvailable,
      planModeEnabled: planEnabled,
      effectiveModeId: planEnabled ? planMode?.id ?? null : selectedAccessModeId,
    };
  }
  const accessModes = extractAccessModes(catalogDescriptors);
  const catalogPlanMode = extractPlanDescriptor(catalogDescriptors);
  const planModeAvailable = Boolean(catalogPlanMode);
  const selectedAccessModeId = resolveSelectedAccessModeId({
    draftModeId: args.draft?.accessModeId,
    defaultModeId: resolveDefaultAccessModeId(catalogDescriptors, args.catalog?.defaultModeId),
    accessModes,
  });
  const planModeEnabled = planModeAvailable ? (args.draft?.planEnabled ?? false) : false;
  return {
    accessModes,
    selectedAccessModeId,
    planModeAvailable,
    planModeEnabled,
    effectiveModeId: planModeEnabled ? catalogPlanMode?.id ?? null : selectedAccessModeId,
  };
}
