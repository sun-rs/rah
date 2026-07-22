import type { SessionSummary } from "@rah/runtime-protocol";
import { ConfirmDialog } from "./ConfirmDialog";

export function StopSessionDialog(props: {
  open: boolean;
  stopping: boolean;
  targetSummary: SessionSummary | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const isEphemeralSide =
    props.targetSummary?.session.relationship?.kind === "side" &&
    props.targetSummary.session.relationship.persistence === "ephemeral";
  const targetTitle =
    props.targetSummary?.session.title ?? props.targetSummary?.session.id;

  return (
    <ConfirmDialog
      open={props.open}
      pending={props.stopping}
      title={isEphemeralSide ? "Discard Side task?" : "Stop session?"}
      description={
        props.targetSummary ? (
          <>
            {isEphemeralSide ? "Discard" : "Stop"}{" "}
            <span className="font-medium text-[var(--app-fg)]">
              {targetTitle}
            </span>
            {isEphemeralSide
              ? "? This removes the ephemeral task from its parent session."
              : "? You can reopen it from Chats."}
          </>
        ) : (
          "Stop this running session? You can reopen it from Chats."
        )
      }
      confirmLabel={
        isEphemeralSide
          ? props.stopping
            ? "Discarding..."
            : "Discard"
          : props.stopping
            ? "Stopping..."
            : "Stop"
      }
      onOpenChange={props.onOpenChange}
      onConfirm={props.onConfirm}
    />
  );
}
