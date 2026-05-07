import type { NativeTuiDiagnostic } from "@rah/runtime-protocol";

export function nativeTuiDiagnosticLabel(kind: NativeTuiDiagnostic["kind"]): string {
  switch (kind) {
    case "binding_missing":
      return "Provider binding";
    case "mirror_source_missing":
    case "mirror_failed":
      return "Chat mirror";
    case "process_exited":
      return "Process exit";
  }
}

export function nativeTuiDiagnosticNoticeMessage(diagnostic: NativeTuiDiagnostic): string {
  return `${nativeTuiDiagnosticLabel(diagnostic.kind)}: ${diagnostic.message}`;
}
