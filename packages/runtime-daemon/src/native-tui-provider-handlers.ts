import type { ProviderKind } from "@rah/runtime-protocol";
import { createClaudeNativeTuiProviderHandler } from "./native-tui-claude-provider-handler";
import { createCodexNativeTuiProviderHandler } from "./native-tui-codex-provider-handler";
import { createOpenCodeNativeTuiProviderHandler } from "./native-tui-opencode-provider-handler";
import {
  EMPTY_NATIVE_TUI_HISTORY_CATALOG,
  type NativeTuiHistoryCatalog,
} from "./native-tui-history-catalog";
import type {
  NativeTuiBindingHandler,
  NativeTuiMirrorHandler,
  NativeTuiProviderHandler,
} from "./native-tui-provider-runtime-types";

function defaultNativeTuiProviderHandlers(
  historyCatalog: NativeTuiHistoryCatalog,
): readonly NativeTuiProviderHandler[] {
  return [
    createCodexNativeTuiProviderHandler(historyCatalog),
    createClaudeNativeTuiProviderHandler(historyCatalog),
    createOpenCodeNativeTuiProviderHandler(historyCatalog),
  ];
}

export function createDefaultNativeTuiBindingHandlers(
  historyCatalog: NativeTuiHistoryCatalog = EMPTY_NATIVE_TUI_HISTORY_CATALOG,
): ReadonlyMap<
  ProviderKind,
  NativeTuiBindingHandler
> {
  return new Map(
    defaultNativeTuiProviderHandlers(historyCatalog).map((handler): [ProviderKind, NativeTuiBindingHandler] => [
      handler.provider,
      handler,
    ]),
  );
}

export function createDefaultNativeTuiMirrorHandlers(
  historyCatalog: NativeTuiHistoryCatalog = EMPTY_NATIVE_TUI_HISTORY_CATALOG,
): ReadonlyMap<
  ProviderKind,
  NativeTuiMirrorHandler
> {
  return new Map(
    defaultNativeTuiProviderHandlers(historyCatalog).map((handler): [ProviderKind, NativeTuiMirrorHandler] => [
      handler.provider,
      handler,
    ]),
  );
}
