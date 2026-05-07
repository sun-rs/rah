import type { ProviderKind } from "@rah/runtime-protocol";
import { createDefaultNativeTuiProviderHandlers } from "./native-tui-provider-handlers";
import type {
  NativeTuiMirrorHandler,
  NativeTuiMirrorUpdate,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

export interface NativeTuiMirrorProvider {
  readonly providers: readonly ProviderKind[];
  supports(provider: ProviderKind): boolean;
  updateMirror(
    session: NativeTuiProviderRuntimeSession,
    mirror: NativeTuiProviderMirror | undefined,
  ): NativeTuiMirrorUpdate;
}

export class DefaultNativeTuiMirrorProvider implements NativeTuiMirrorProvider {
  private readonly handlers: ReadonlyMap<ProviderKind, NativeTuiMirrorHandler>;
  readonly providers: readonly ProviderKind[];

  constructor(handlers: ReadonlyMap<ProviderKind, NativeTuiMirrorHandler> = createDefaultNativeTuiProviderHandlers()) {
    this.handlers = handlers;
    this.providers = [...handlers.keys()];
  }

  supports(provider: ProviderKind): boolean {
    return this.handlers.has(provider);
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
}

export function createDefaultNativeTuiMirrorProvider(): NativeTuiMirrorProvider {
  return new DefaultNativeTuiMirrorProvider();
}
