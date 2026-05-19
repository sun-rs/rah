import type { SessionSummary } from "@rah/runtime-protocol";
import { ConfirmDialog } from "./ConfirmDialog";

export function StopSessionDialog(props: {
  open: boolean;
  stopping: boolean;
  targetSummary: SessionSummary | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={props.open}
      pending={props.stopping}
      title="Stop session?"
      description={
        props.targetSummary ? (
          <>
            Stop{" "}
            <span className="font-medium text-[var(--app-fg)]">
              {props.targetSummary.session.title ?? props.targetSummary.session.id}
            </span>
            ? You can reopen it from Chats.
          </>
        ) : (
          "Stop this running session? You can reopen it from Chats."
        )
      }
      confirmLabel={props.stopping ? "Stopping..." : "Stop"}
      onOpenChange={props.onOpenChange}
      onConfirm={props.onConfirm}
    />
  );
}
