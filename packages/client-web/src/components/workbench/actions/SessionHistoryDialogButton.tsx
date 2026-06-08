import { lazy, Suspense, useState } from "react";
import { MessageCircleMore } from "lucide-react";
import { importWithStaleReload } from "../../../lazy-module-reload";
import type { SessionHistoryDialogProps } from "../../SessionHistoryDialog";

const SessionHistoryDialog = lazy(async () => ({
  default: (await importWithStaleReload(() => import("../../SessionHistoryDialog")))
    .SessionHistoryDialog,
}));

export function SessionHistoryDialogButton(
  props: Omit<SessionHistoryDialogProps, "children" | "open" | "onOpenChange"> & {
    buttonClassName: string;
    iconSize: number;
  },
) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  const openDialog = () => {
    setMounted(true);
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className={props.buttonClassName}
        aria-label="Chats"
        title="Chats"
        onClick={openDialog}
      >
        <MessageCircleMore size={props.iconSize} />
      </button>
      {mounted ? (
        <Suspense fallback={null}>
          <SessionHistoryDialog {...props} open={open} onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}
