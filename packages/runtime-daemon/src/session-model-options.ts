import type {
  ProviderModelCatalog,
  SessionConfigOption,
  SessionConfigValue,
  SessionModelDescriptor,
} from "@rah/runtime-protocol";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSessionConfigValue(value: unknown): value is SessionConfigValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function modelConfigOptionsForModel(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
}): SessionConfigOption[] {
  if (!args.catalog || !args.modelId) {
    return [];
  }
  const profile = args.catalog.modelProfiles?.find(
    (entry) => entry.modelId === args.modelId,
  );
  if (profile) {
    return profile.configOptions;
  }
  return (args.catalog.configOptions ?? []).filter((option) => {
    const modelIds = option.availability?.modelIds;
    return !modelIds || modelIds.includes(args.modelId!);
  });
}

function validateOptionValue(option: SessionConfigOption, value: SessionConfigValue): void {
  if (value === null) {
    return;
  }
  switch (option.kind) {
    case "select": {
      if (typeof value !== "string") {
        throw new Error(`Model option '${option.id}' must be a string choice.`);
      }
      if (option.options && !option.options.some((choice) => choice.id === value)) {
        throw new Error(`Unsupported value '${value}' for model option '${option.id}'.`);
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new Error(`Model option '${option.id}' must be a boolean.`);
      }
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Model option '${option.id}' must be a finite number.`);
      }
      if (option.constraints?.min !== undefined && value < option.constraints.min) {
        throw new Error(`Model option '${option.id}' must be >= ${option.constraints.min}.`);
      }
      if (option.constraints?.max !== undefined && value > option.constraints.max) {
        throw new Error(`Model option '${option.id}' must be <= ${option.constraints.max}.`);
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        throw new Error(`Model option '${option.id}' must be a string.`);
      }
      return;
    }
  }
}

export function validateModelOptionValues(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string;
  optionValues?: Record<string, SessionConfigValue> | null | undefined;
  requireMutable?: boolean;
}): Record<string, SessionConfigValue> {
  if (args.optionValues === undefined || args.optionValues === null) {
    return {};
  }
  if (!isPlainRecord(args.optionValues)) {
    throw new Error("Model option values must be an object.");
  }
  const options = modelConfigOptionsForModel({
    catalog: args.catalog,
    modelId: args.modelId,
  });
  const optionsById = new Map(options.map((option) => [option.id, option]));
  const next: Record<string, SessionConfigValue> = {};
  for (const [optionId, value] of Object.entries(args.optionValues)) {
    if (!optionId.trim()) {
      throw new Error("Model option id is required.");
    }
    if (!isSessionConfigValue(value)) {
      throw new Error(`Model option '${optionId}' has an unsupported value type.`);
    }
    const option = optionsById.get(optionId);
    if (!option) {
      throw new Error(`Unsupported model option '${optionId}' for model '${args.modelId}'.`);
    }
    if (args.requireMutable && !option.mutable) {
      throw new Error(`Model option '${optionId}' is not mutable for this session.`);
    }
    validateOptionValue(option, value);
    next[optionId] = value;
  }
  return next;
}

function findLegacyReasoningConfigOption(args: {
  catalog: ProviderModelCatalog | null | undefined;
  model: SessionModelDescriptor;
}): SessionConfigOption | null {
  const options = modelConfigOptionsForModel({
    catalog: args.catalog,
    modelId: args.model.id,
  }).filter((option) => option.kind === "select");
  const reasoningOptionIds = new Set(
    (args.model.reasoningOptions ?? []).map((option) => option.id),
  );
  return (
    options.find((option) =>
      option.options?.some((choice) => reasoningOptionIds.has(choice.id)),
    ) ??
    options.find((option) => option.backendKey !== undefined) ??
    options[0] ??
    null
  );
}

export function resolveModelOptionValues(args: {
  catalog: ProviderModelCatalog | null | undefined;
  model: SessionModelDescriptor;
  optionValues?: Record<string, SessionConfigValue> | null | undefined;
  reasoningId?: string | null | undefined;
  useDefaults?: boolean;
  requireMutable?: boolean;
}): Record<string, SessionConfigValue> {
  const next = validateModelOptionValues({
    catalog: args.catalog,
    modelId: args.model.id,
    optionValues: args.optionValues,
    requireMutable: args.requireMutable,
  });
  const legacyOption = findLegacyReasoningConfigOption({
    catalog: args.catalog,
    model: args.model,
  });

  if (args.reasoningId !== undefined) {
    if (!legacyOption) {
      if (args.reasoningId !== null) {
        throw new Error(
          `Model '${args.model.id}' does not expose a legacy reasoning option.`,
        );
      }
    } else {
      const legacyValue =
        args.reasoningId === null ? null : args.reasoningId.trim();
      if (legacyValue === "") {
        throw new Error("Reasoning option is required.");
      }
      const existingValue = next[legacyOption.id];
      if (
        existingValue !== undefined &&
        existingValue !== legacyValue
      ) {
        throw new Error(
          `Conflicting values for model option '${legacyOption.id}'.`,
        );
      }
      next[legacyOption.id] = legacyValue;
    }
  }

  if (args.useDefaults) {
    for (const option of modelConfigOptionsForModel({
      catalog: args.catalog,
      modelId: args.model.id,
    })) {
      if (next[option.id] === undefined && option.defaultValue !== undefined) {
        next[option.id] = option.defaultValue;
      }
    }
  }

  return validateModelOptionValues({
    catalog: args.catalog,
    modelId: args.model.id,
    optionValues: next,
    requireMutable: args.requireMutable,
  });
}

export function optionValueAsString(
  values: Record<string, SessionConfigValue>,
  optionId: string,
): string | null | undefined {
  const value = values[optionId];
  if (value === undefined || value === null) {
    return value;
  }
  return String(value);
}
