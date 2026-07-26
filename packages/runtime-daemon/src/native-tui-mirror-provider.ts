import type { ProviderKind } from "@rah/runtime-protocol";
import { createDefaultNativeTuiMirrorHandlers } from "./native-tui-provider-handlers";
import type { NativeTuiHistoryCatalog } from "./native-tui-history-catalog";
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
  ): Promise<NativeTuiMirrorUpdate>;
}

export class DefaultNativeTuiMirrorProvider implements NativeTuiMirrorProvider {
  private readonly handlers: ReadonlyMap<ProviderKind, NativeTuiMirrorHandler>;
  readonly providers: readonly ProviderKind[];

  constructor(handlers: ReadonlyMap<ProviderKind, NativeTuiMirrorHandler> = createDefaultNativeTuiMirrorHandlers()) {
    this.handlers = handlers;
    this.providers = [...handlers.keys()];
  }

  supports(provider: ProviderKind): boolean {
    return this.handlers.has(provider);
  }

  async updateMirror(
    session: NativeTuiProviderRuntimeSession,
    mirror: NativeTuiProviderMirror | undefined,
  ): Promise<NativeTuiMirrorUpdate> {
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
      return await handler.updateMirror(session, mirror);
    } catch (error) {
      return { status: "failed", ...(mirror ? { mirror } : {}), phase: "mirror_tick", error };
    }
  }
}

export function createDefaultNativeTuiMirrorProvider(
  historyCatalog?: NativeTuiHistoryCatalog,
): NativeTuiMirrorProvider {
  return new DefaultNativeTuiMirrorProvider(
    createDefaultNativeTuiMirrorHandlers(historyCatalog),
  );
}
