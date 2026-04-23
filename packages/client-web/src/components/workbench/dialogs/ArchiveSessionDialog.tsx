import type { SessionSummary } from "@rah/runtime-protocol";
import { ConfirmDialog } from "./ConfirmDialog";

export function ArchiveSessionDialog(props: {
  open: boolean;
  archiving: boolean;
  targetSummary: SessionSummary | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={props.open}
      pending={props.archiving}
      title="Archive session?"
      description={
        props.targetSummary ? (
          <>
            Archive{" "}
            <span className="font-medium text-[var(--app-fg)]">
              {props.targetSummary.session.title ?? props.targetSummary.session.id}
            </span>
            ? You can reopen it from Session History.
          </>
        ) : (
          "Archive this live session? You can reopen it from Session History."
        )
      }
      confirmLabel={props.archiving ? "Archiving…" : "Archive"}
      onOpenChange={props.onOpenChange}
      onConfirm={props.onConfirm}
    />
  );
}
