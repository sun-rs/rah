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
  default: "Default",
  build: "Build",
  plan: "Plan",
  acceptEdits: "Accept Edits",
  auto_edit: "Auto edit",
  "on-request/workspace-write": "Default",
  "auto-review/workspace-write": "Auto Review",
  "on-request/read-only": "Ask",
  "never/workspace-write": "Full auto · sandboxed",
  "never/danger-full-access": "Full Access",
  bypassPermissions: "Bypass Permissions",
  yolo: "Full auto",
};
const CODEX_PLAN_MODE_ID_PREFIX = "plan:";

export function codexPlanModeId(accessModeId: string | null): string | null {
  const trimmed = accessModeId?.trim();
  return trimmed ? `${CODEX_PLAN_MODE_ID_PREFIX}${trimmed}` : "plan";
}

function extractPlanDescriptor(
  provider: SupportedModeProvider,
  availableModes: readonly SessionModeDescriptor[],
): SessionModeDescriptor | null {
  if (!shouldSplitPlanMode(provider)) {
    return null;
  }
  return availableModes.find((mode) => mode.role === "plan" || mode.id === "plan") ?? null;
}

function shouldSplitPlanMode(provider: SupportedModeProvider): boolean {
  return provider === "codex";
}

function isSplitPlanMode(
  provider: SupportedModeProvider,
  mode: SessionModeDescriptor,
): boolean {
  if (!shouldSplitPlanMode(provider)) {
    return false;
  }
  return mode.role === "plan" || mode.id === "plan";
}

function normalizeModeLabel(
  provider: SupportedModeProvider,
  mode: SessionModeDescriptor,
): string {
  if (!(provider === "opencode" && mode.role === "custom")) {
    const legacyLabel = LEGACY_ACCESS_MODE_LABELS[mode.id];
    if (legacyLabel) {
      return legacyLabel;
    }
  }
  if (mode.role && mode.role !== "custom") {
    if (mode.role === "full_auto" && mode.label.toLowerCase().includes("sandbox")) {
      return mode.label;
    }
    if (!mode.label || mode.label === ROLE_LABELS[mode.role]) {
      return ROLE_LABELS[mode.role];
    }
    return mode.label;
  }
  return mode.label ?? mode.id;
}

function extractAccessModes(
  provider: SupportedModeProvider,
  availableModes: readonly SessionModeDescriptor[],
): SessionModeChoice[] {
  return availableModes
    .filter((mode) => !isSplitPlanMode(provider, mode))
    .map((mode) => ({
      id: mode.id,
      label: normalizeModeLabel(provider, mode),
      ...(mode.description ? { description: mode.description } : {}),
      ...(mode.applyTiming ? { applyTiming: mode.applyTiming } : {}),
    }));
}

function resolveEffectiveModeId(args: {
  provider: SupportedModeProvider;
  planEnabled: boolean;
  planModeId: string | null | undefined;
  selectedAccessModeId: string | null;
}): string | null {
  if (!args.planEnabled) {
    return args.selectedAccessModeId;
  }
  if (args.provider === "codex") {
    return codexPlanModeId(args.selectedAccessModeId);
  }
  return args.planModeId ?? null;
}

function resolveDefaultAccessModeId(
  provider: SupportedModeProvider,
  descriptors: readonly SessionModeDescriptor[],
  explicitDefaultModeId: string | null | undefined,
): string | null {
  if (
    explicitDefaultModeId &&
    !descriptors.some((mode) => mode.id === explicitDefaultModeId && isSplitPlanMode(provider, mode))
  ) {
    return explicitDefaultModeId;
  }
  const fullAutoMode = [...descriptors]
    .reverse()
    .find((mode) => mode.role === "full_auto");
  if (fullAutoMode) {
    return fullAutoMode.id;
  }
  const accessModes = extractAccessModes(provider, descriptors);
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
  const catalogDescriptors = args.catalog?.modes ?? [];
  if (args.summary?.session.mode) {
    const descriptors =
      args.summary.session.mode.availableModes.length > 0
        ? args.summary.session.mode.availableModes
        : catalogDescriptors;
    const accessModes = extractAccessModes(args.provider, descriptors);
    const planMode = extractPlanDescriptor(args.provider, descriptors);
    const planModeAvailable = Boolean(planMode);
    const currentModeId = args.summary.session.mode.currentModeId;
    const currentModeIsSplitPlan =
      currentModeId !== null &&
      currentModeId !== undefined &&
      descriptors.some((mode) => mode.id === currentModeId && isSplitPlanMode(args.provider, mode));
    const defaultAccessModeId = resolveDefaultAccessModeId(
      args.provider,
      descriptors,
      args.catalog?.defaultModeId,
    );
    const selectedAccessModeId = resolveSelectedAccessModeId({
      currentModeId: currentModeIsSplitPlan ? null : currentModeId,
      draftModeId: args.draft?.accessModeId,
      defaultModeId: currentModeIsSplitPlan
        ? accessModes[0]?.id ?? defaultAccessModeId
        : defaultAccessModeId,
      accessModes,
    });
    const planEnabled =
      currentModeIsSplitPlan
        ? true
        : planModeAvailable && (args.draft?.planEnabled ?? false);
    return {
      accessModes,
      selectedAccessModeId,
      planModeAvailable,
      planModeEnabled: planEnabled,
      effectiveModeId: resolveEffectiveModeId({
        provider: args.provider,
        planEnabled,
        planModeId: planMode?.id,
        selectedAccessModeId,
      }),
    };
  }
  const accessModes = extractAccessModes(args.provider, catalogDescriptors);
  const catalogPlanMode = extractPlanDescriptor(args.provider, catalogDescriptors);
  const planModeAvailable = Boolean(catalogPlanMode);
  const selectedAccessModeId = resolveSelectedAccessModeId({
    draftModeId: args.draft?.accessModeId,
    defaultModeId: resolveDefaultAccessModeId(args.provider, catalogDescriptors, args.catalog?.defaultModeId),
    accessModes,
  });
  const planModeEnabled = planModeAvailable ? (args.draft?.planEnabled ?? false) : false;
  return {
    accessModes,
    selectedAccessModeId,
    planModeAvailable,
    planModeEnabled,
    effectiveModeId: resolveEffectiveModeId({
      provider: args.provider,
      planEnabled: planModeEnabled,
      planModeId: catalogPlanMode?.id,
      selectedAccessModeId,
    }),
  };
}
