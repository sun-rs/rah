import {
  useRef,
  useState,
  type ClipboardEventHandler,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  SessionConfigValue,
  SessionInputAttachment,
  SessionInputAnnotation,
  SessionSummary,
} from "@rah/runtime-protocol";
import type { ProviderChoice } from "../components/ProviderSelector";
import { insertTextAtSelection } from "../composer-text-insertion";
import { imageFilesFromClipboardData } from "../composer-image-attachments";
import { useComposerAttachments } from "./useComposerAttachments";
import { useComposerAnnotations } from "./useComposerAnnotations";
import {
  createComposerAnnotation,
  type SelectedConversationText,
} from "../composer-annotations";

const MORE_DETAILS_PROMPT =
  "请详细说明这段选中的内容，并结合当前任务上下文解释它的含义和影响。";

type StartSessionInput = {
  provider: ProviderChoice;
  cwd: string;
  title: string;
  initialInput: string;
  initialAttachments?: SessionInputAttachment[];
  initialAnnotations?: SessionInputAnnotation[];
  modeId?: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string;
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  onSessionCreated?: (sessionId: string) => void;
};

type SendInputFn = (
  sessionId: string,
  text: string,
  attachments?: SessionInputAttachment[],
  options?: { annotations?: SessionInputAnnotation[] },
) => Promise<unknown>;
type StartSessionFn = (options: StartSessionInput) => Promise<string | null>;

export function useWorkbenchComposerState(args: {
  selectedSummary: SessionSummary | null;
  availableWorkspaceDir: string;
  newSessionProvider: ProviderChoice;
  startModeId: string | null;
  startModelId?: string | null;
  startReasoningId?: string | null;
  startOptionValues?: Record<string, SessionConfigValue>;
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  sendInput: SendInputFn;
  startSession: StartSessionFn;
}) {
  const draftKey = composerDraftKey(args.selectedSummary);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = draftKey ? drafts[draftKey] ?? "" : "";
  const setDraft: Dispatch<SetStateAction<string>> = (nextDraft) => {
    if (!draftKey) return;
    setDrafts((current) => updateComposerDraftMap(current, draftKey, nextDraft));
  };
  const draftAttachments = useComposerAttachments(draftKey ?? "no-session");
  const draftAnnotations = useComposerAnnotations(draftKey ?? "no-session");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [emptyStateDraft, setEmptyStateDraft] = useState("");
  const emptyStateAttachments = useComposerAttachments();
  const emptyStateComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const emptyStateSendInFlightRef = useRef(false);
  const [emptyStateSendPending, setEmptyStateSendPending] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSendCountRef = useRef(0);

  const insertPlainTextFromPaste = (
    current: string,
    textarea: HTMLTextAreaElement,
    text: string,
  ): string => {
    if (!text) {
      return current;
    }
    const { nextValue, caret } = insertTextAtSelection({
      current,
      selectionStart: textarea.selectionStart ?? current.length,
      selectionEnd: textarea.selectionEnd ?? current.length,
      insertedText: text,
    });
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
    return nextValue;
  };

  const createImagePasteHandler = (
    textareaRef: RefObject<HTMLTextAreaElement | null>,
    setText: Dispatch<SetStateAction<string>>,
    uploadFiles: (files: readonly File[]) => Promise<void>,
  ): ClipboardEventHandler<HTMLTextAreaElement> => (event) => {
    const files = imageFilesFromClipboardData(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    const textarea = textareaRef.current ?? event.currentTarget;
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      setText((current) => insertPlainTextFromPaste(current, textarea, pastedText));
    }
    void uploadFiles(files);
  };

  const handleDraftPaste = createImagePasteHandler(
    composerRef,
    setDraft,
    draftAttachments.uploadFiles,
  );
  const handleEmptyStatePaste = createImagePasteHandler(
    emptyStateComposerRef,
    setEmptyStateDraft,
    emptyStateAttachments.uploadFiles,
  );

  const handleSend = async () => {
    if (
      !args.selectedSummary ||
      (!draft.trim() && draftAttachments.count === 0)
    ) {
      return;
    }
    const textDraft = draft;
    const attachmentDraft = draftAttachments.take();
    const annotationDraft = draftAnnotations.take();
    const sessionId = args.selectedSummary.session.id;
    setDraft("");
    pendingSendCountRef.current += 1;
    setSendPending(true);
    const sendTask = async () => {
      try {
        await args.sendInput(
          sessionId,
          textDraft,
          attachmentDraft.map((item) => item.attachment),
          annotationDraft.length ? { annotations: annotationDraft } : undefined,
        );
        draftAttachments.release(attachmentDraft);
      } catch {
        setDraft((current) => (current.trim() ? current : textDraft));
        draftAttachments.restore(attachmentDraft);
        draftAnnotations.restore(annotationDraft);
      } finally {
        pendingSendCountRef.current = Math.max(0, pendingSendCountRef.current - 1);
        if (pendingSendCountRef.current === 0) {
          setSendPending(false);
        }
      }
    };
    sendChainRef.current = sendChainRef.current.catch(() => undefined).then(sendTask);
    await sendChainRef.current;
  };

  const handleEmptyStateSend = () => {
    if (emptyStateSendInFlightRef.current) {
      return;
    }
    const textDraft = emptyStateDraft;
    const attachmentDraft = emptyStateAttachments.take();
    if ((!textDraft.trim() && attachmentDraft.length === 0) || !args.availableWorkspaceDir) {
      emptyStateAttachments.restore(attachmentDraft);
      return;
    }
    emptyStateSendInFlightRef.current = true;
    setEmptyStateSendPending(true);
    setEmptyStateDraft("");
    const title = textDraft.trim()
      ? textDraft.trim().slice(0, 50)
      : attachmentDraft.some((item) => item.attachment.kind === "image")
        ? "Image prompt"
        : "File prompt";
    let createdSessionId: string | null = null;
    const restoreNewTaskSubmission = () => {
      setEmptyStateDraft((current) => (current.trim() ? current : textDraft));
      emptyStateAttachments.restore(attachmentDraft);
    };
    void (async () => {
      try {
        const resolvedSessionId = await args.startSession({
          provider: args.newSessionProvider,
          cwd: args.availableWorkspaceDir,
          title,
          initialInput: textDraft,
          initialAttachments: attachmentDraft.map((item) => item.attachment),
          ...(args.startModeId ? { modeId: args.startModeId } : {}),
          ...(args.startModelId ? { model: args.startModelId } : {}),
          ...(args.startOptionValues ? { optionValues: args.startOptionValues } : {}),
          ...(args.startReasoningId ? { reasoningId: args.startReasoningId } : {}),
          ...(args.confirmCreateMissingWorkspace
            ? { confirmCreateMissingWorkspace: args.confirmCreateMissingWorkspace }
            : {}),
          onSessionCreated: (sessionId) => {
            createdSessionId = sessionId;
          },
        });
        if (createdSessionId || resolvedSessionId) {
          emptyStateAttachments.release(attachmentDraft);
        } else {
          restoreNewTaskSubmission();
        }
      } catch {
        // A created Session is not proof that its first turn was accepted.
        // Keep the user-owned draft whenever startup rejects so it can never
        // disappear between Session creation and provider delivery.
        restoreNewTaskSubmission();
      } finally {
        emptyStateSendInFlightRef.current = false;
        setEmptyStateSendPending(false);
      }
    })();
  };

  const insertDraftReference = (reference: string) => {
    setDraft((current) => {
      const textarea = composerRef.current;
      if (!textarea) {
        return current ? `${current} ${reference}` : reference;
      }
      const { nextValue, caret } = insertTextAtSelection({
        current,
        selectionStart: textarea.selectionStart ?? current.length,
        selectionEnd: textarea.selectionEnd ?? current.length,
        insertedText: reference,
      });
      queueMicrotask(() => {
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
      return nextValue;
    });
  };

  const insertEmptyStateReference = (reference: string) => {
    setEmptyStateDraft((current) => {
      const textarea = emptyStateComposerRef.current;
      if (!textarea) {
        return current ? `${current} ${reference}` : reference;
      }
      const { nextValue, caret } = insertTextAtSelection({
        current,
        selectionStart: textarea.selectionStart ?? current.length,
        selectionEnd: textarea.selectionEnd ?? current.length,
        insertedText: reference,
      });
      queueMicrotask(() => {
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
      return nextValue;
    });
  };

  const addDraftSelectedText = (selection: SelectedConversationText) => {
    const annotation = createComposerAnnotation(selection);
    if (!annotation) {
      return;
    }
    draftAnnotations.add(annotation);
    queueMicrotask(() => composerRef.current?.focus());
  };

  const requestDraftSelectedTextDetails = (selection: SelectedConversationText) => {
    const annotation = createComposerAnnotation(selection);
    if (!annotation) {
      return;
    }
    draftAnnotations.add(annotation);
    setDraft((current) => {
      if (current.includes(MORE_DETAILS_PROMPT)) {
        return current;
      }
      return current.trim()
        ? `${current.trimEnd()}\n\n${MORE_DETAILS_PROMPT}`
        : MORE_DETAILS_PROMPT;
    });
    queueMicrotask(() => {
      const textarea = composerRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  };

  return {
    composerRef,
    draft,
    draftAttachments: draftAttachments.items,
    draftAttachmentCount: draftAttachments.count,
    draftAttachmentUploadPending: draftAttachments.uploading,
    draftAttachmentError: draftAttachments.error,
    draftAnnotations: draftAnnotations.items,
    draftAnnotationCount: draftAnnotations.count,
    emptyStateComposerRef,
    emptyStateDraft,
    emptyStateAttachments: emptyStateAttachments.items,
    emptyStateAttachmentCount: emptyStateAttachments.count,
    emptyStateAttachmentUploadPending: emptyStateAttachments.uploading,
    emptyStateAttachmentError: emptyStateAttachments.error,
    emptyStateSendPending,
    sendPending,
    setDraft,
    setEmptyStateDraft,
    handleDraftPaste,
    handleEmptyStatePaste,
    uploadDraftFiles: draftAttachments.uploadFiles,
    uploadEmptyStateFiles: emptyStateAttachments.uploadFiles,
    clearDraftAttachments: draftAttachments.clear,
    clearDraftAnnotations: draftAnnotations.clear,
    clearEmptyStateAttachments: emptyStateAttachments.clear,
    removeDraftAttachment: draftAttachments.remove,
    removeEmptyStateAttachment: emptyStateAttachments.remove,
    removeLastDraftAttachment: draftAttachments.removeLast,
    removeLastEmptyStateAttachment: emptyStateAttachments.removeLast,
    removeDraftAnnotation: draftAnnotations.remove,
    handleSend,
    handleEmptyStateSend,
    insertDraftReference,
    insertEmptyStateReference,
    addDraftSelectedText,
    requestDraftSelectedTextDetails,
  };
}

export function composerDraftKey(summary: SessionSummary | null): string | null {
  if (!summary) return null;
  const providerSessionId = summary.session.providerSessionId?.trim();
  return providerSessionId
    ? `${summary.session.provider}:${providerSessionId}`
    : `runtime:${summary.session.id}`;
}

export function updateComposerDraftMap(
  current: Readonly<Record<string, string>>,
  key: string,
  nextDraft: SetStateAction<string>,
): Record<string, string> {
  const currentDraft = current[key] ?? "";
  const value = typeof nextDraft === "function"
    ? nextDraft(currentDraft)
    : nextDraft;
  if (value === currentDraft) return current as Record<string, string>;
  if (!value) {
    const next = { ...current };
    delete next[key];
    return next;
  }
  return { ...current, [key]: value };
}
