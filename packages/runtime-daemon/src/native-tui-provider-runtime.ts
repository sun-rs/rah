import type {
  ProviderKind,
  ResumeSessionRequest,
  StartSessionRequest,
} from "@rah/runtime-protocol";
import {
  nativeTuiResumeLaunchSpec,
  nativeTuiStartLaunchSpec,
  type NativeTuiLaunchSpec,
} from "./native-tui-launch-spec";
import { createDefaultNativeTuiProviderHandlers } from "./native-tui-provider-handlers";
import type {
  NativeTuiBindingCandidate,
  NativeTuiMirrorUpdate,
  NativeTuiOutputObservation,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

export type {
  NativeTuiBindingCandidate,
  NativeTuiBindingRecord,
  NativeTuiMirrorUpdate,
  NativeTuiOutputObservation,
  NativeTuiProviderActivityEnvelope,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

export interface NativeTuiProviderRuntime {
  readonly providers: readonly ProviderKind[];
  supports(provider: ProviderKind): boolean;
  startLaunchSpec(request: StartSessionRequest): Promise<NativeTuiLaunchSpec>;
  resumeLaunchSpec(request: ResumeSessionRequest): Promise<NativeTuiLaunchSpec>;
  canProbeBinding(provider: ProviderKind): boolean;
  observeOutput(session: NativeTuiProviderRuntimeSession, data: string): NativeTuiOutputObservation;
  probeBinding(session: NativeTuiProviderRuntimeSession): NativeTuiBindingCandidate | null;
  updateMirror(
    session: NativeTuiProviderRuntimeSession,
    mirror: NativeTuiProviderMirror | undefined,
  ): NativeTuiMirrorUpdate;
}

const EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION: NativeTuiOutputObservation = {
  promptClean: false,
  binding: null,
};

export class DefaultNativeTuiProviderRuntime implements NativeTuiProviderRuntime {
  private readonly handlers: ReadonlyMap<ProviderKind, NativeTuiProviderHandler>;
  readonly providers: readonly ProviderKind[];

  constructor(handlers = createDefaultNativeTuiProviderHandlers()) {
    this.handlers = handlers;
    this.providers = [...handlers.keys()];
  }

  supports(provider: ProviderKind): boolean {
    return this.handlers.has(provider);
  }

  async startLaunchSpec(request: StartSessionRequest): Promise<NativeTuiLaunchSpec> {
    this.assertSupported(request.provider);
    return await nativeTuiStartLaunchSpec(request);
  }

  async resumeLaunchSpec(request: ResumeSessionRequest): Promise<NativeTuiLaunchSpec> {
    this.assertSupported(request.provider);
    return await nativeTuiResumeLaunchSpec(request);
  }

  canProbeBinding(provider: ProviderKind): boolean {
    return this.handlers.get(provider)?.canProbeBinding === true;
  }

  observeOutput(
    session: NativeTuiProviderRuntimeSession,
    data: string,
  ): NativeTuiOutputObservation {
    return this.handlers.get(session.provider)?.observeOutput?.(session, data) ??
      EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION;
  }

  probeBinding(session: NativeTuiProviderRuntimeSession): NativeTuiBindingCandidate | null {
    if (session.providerSessionId) {
      return null;
    }
    return this.handlers.get(session.provider)?.probeBinding?.(session) ?? null;
  }

  updateMirror(
    session: NativeTuiProviderRuntimeSession,
    mirror: NativeTuiProviderMirror | undefined,
  ): NativeTuiMirrorUpdate {
    if (!session.providerSessionId) {
      return { status: "unbound", ...(mirror ? { mirror } : {}) };
    }
    if (
      mirror &&
      (mirror.provider !== session.provider || mirror.providerSessionId !== session.providerSessionId)
    ) {
      mirror = undefined;
    }
    const handler = this.handlers.get(session.provider);
    if (!handler) {
      return { status: "unsupported", ...(mirror ? { mirror } : {}) };
    }
    try {
      return handler.updateMirror(session, mirror);
    } catch (error) {
      return { status: "failed", ...(mirror ? { mirror } : {}), phase: "mirror_tick", error };
    }
  }

  private assertSupported(provider: ProviderKind): void {
    if (!this.supports(provider)) {
      throw new Error(`Native TUI live backend is not implemented for ${provider}.`);
    }
  }
}

export function createDefaultNativeTuiProviderRuntime(): NativeTuiProviderRuntime {
  return new DefaultNativeTuiProviderRuntime();
}
