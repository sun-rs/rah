import * as Dialog from "@radix-ui/react-dialog";
import { FileSearch, LoaderCircle, Plus, Upload, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { usePwaDisplayMode } from "../hooks/usePwaDisplayMode";

function readCompactTouchViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 900px) and (pointer: coarse)").matches
  );
}

export function ComposerAttachmentControl(props: {
  buttonClassName: string;
  referenceDisabled?: boolean;
  referenceDisabledTitle?: string;
  onReferenceWorkspaceFile: () => void;
  onUploadFiles: (files: readonly File[]) => void | Promise<void>;
  uploadPending?: boolean;
}) {
  const isPwa = usePwaDisplayMode();
  const [compactTouchViewport, setCompactTouchViewport] = useState(readCompactTouchViewport);
  const [menuOpen, setMenuOpen] = useState(false);
  const deviceInputId = useId();

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px) and (pointer: coarse)");
    const update = () => setCompactTouchViewport(media.matches);
    media.addEventListener?.("change", update);
    update();
    return () => media.removeEventListener?.("change", update);
  }, []);

  const useMobileMenu = isPwa || compactTouchViewport;
  const uploadInProgress = props.uploadPending === true;
  const chooseFiles = (input: HTMLInputElement) => {
    const files = input.files ? [...input.files] : [];
    input.value = "";
    if (files.length > 0) {
      setMenuOpen(false);
      void props.onUploadFiles(files);
    }
  };

  const openReferencePicker = () => {
    setMenuOpen(false);
    props.onReferenceWorkspaceFile();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (useMobileMenu) {
            setMenuOpen(true);
          } else {
            props.onReferenceWorkspaceFile();
          }
        }}
        disabled={props.uploadPending || (!useMobileMenu && props.referenceDisabled)}
        className={`${props.buttonClassName} ${
          uploadInProgress
            ? "cursor-progress border-sky-400/60 bg-sky-500/12 text-sky-600 opacity-100 dark:border-sky-400/50 dark:bg-sky-400/12 dark:text-sky-300"
            : "disabled:cursor-not-allowed disabled:opacity-40"
        }`}
        title={
          uploadInProgress
            ? "Uploading attachments…"
            : !useMobileMenu && props.referenceDisabled
            ? props.referenceDisabledTitle
            : "Add a reference or attachment"
        }
        aria-label={uploadInProgress ? "Uploading attachments" : "Add a reference or attachment"}
        aria-busy={uploadInProgress}
      >
        {uploadInProgress ? (
          <LoaderCircle
            size={18}
            className="h-[18px] w-[18px] animate-spin md:h-4 md:w-4"
          />
        ) : (
          <Plus
            size={20}
            strokeWidth={1.75}
            className="h-5 w-5 md:h-[18px] md:w-[18px]"
          />
        )}
      </button>

      <input
        id={deviceInputId}
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose files from this device"
        onChange={(event) => chooseFiles(event.currentTarget)}
      />

      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/35" />
          <Dialog.Content className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] z-[81] rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2 shadow-2xl outline-none sm:left-1/2 sm:right-auto sm:w-80 sm:-translate-x-1/2">
            <div className="flex items-center justify-between px-2 py-1.5">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                Add to message
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                  aria-label="Close attachment menu"
                >
                  <X size={17} />
                </button>
              </Dialog.Close>
            </div>
            <div className="grid gap-1">
              <button
                type="button"
                onClick={openReferencePicker}
                disabled={props.referenceDisabled}
                title={props.referenceDisabled ? props.referenceDisabledTitle : undefined}
                className="icon-click-feedback flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FileSearch size={18} className="shrink-0 text-[var(--app-hint)]" />
                <span>Reference workspace file</span>
              </button>
              <label
                htmlFor={deviceInputId}
                className="icon-click-feedback flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
              >
                <Upload size={18} className="shrink-0 text-[var(--app-hint)]" />
                <span>Choose from device</span>
              </label>
            </div>
            <Dialog.Description className="sr-only">
              Reference a workspace file or choose an attachment from this device.
            </Dialog.Description>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
