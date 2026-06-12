import {
  useRef,
  useState,
  type ClipboardEventHandler,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { SessionConfigValue, SessionSummary } from "@rah/runtime-protocol";
import type { ProviderChoice } from "../components/ProviderSelector";
import { insertTextAtSelection } from "../composer-text-insertion";
import {
  appendImageDataUrlsToText,
  imageFilesFromClipboardData,
  readImageDataUrlsFromClipboardData,
} from "../composer-image-attachments";

type StartSessionInput = {
  provider: ProviderChoice;
  cwd: string;
  title: string;
  initialInput: string;
  modeId?: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string;
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
};

type SendInputFn = (sessionId: string, text: string) => Promise<unknown>;
type StartSessionFn = (options: StartSessionInput) => Promise<unknown>;

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
  const [draft, setDraft] = useState("");
  const [draftImageDataUrls, setDraftImageDataUrls] = useState<string[]>([]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [emptyStateDraft, setEmptyStateDraft] = useState("");
  const [emptyStateImageDataUrls, setEmptyStateImageDataUrls] = useState<string[]>([]);
  const emptyStateComposerRef = useRef<HTMLTextAreaElement | null>(null);
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
    setImages: Dispatch<SetStateAction<string[]>>,
  ): ClipboardEventHandler<HTMLTextAreaElement> => (event) => {
    if (imageFilesFromClipboardData(event.clipboardData).length === 0) {
      return;
    }
    event.preventDefault();
    const textarea = textareaRef.current ?? event.currentTarget;
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      setText((current) => insertPlainTextFromPaste(current, textarea, pastedText));
    }
    void readImageDataUrlsFromClipboardData(event.clipboardData)
      .then((urls) => {
        if (urls.length > 0) {
          setImages((current) => [...current, ...urls]);
        }
      })
      .catch(() => undefined);
  };

  const handleDraftPaste = createImagePasteHandler(
    composerRef,
    setDraft,
    setDraftImageDataUrls,
  );
  const handleEmptyStatePaste = createImagePasteHandler(
    emptyStateComposerRef,
    setEmptyStateDraft,
    setEmptyStateImageDataUrls,
  );

  const clearDraftImages = () => setDraftImageDataUrls([]);
  const clearEmptyStateImages = () => setEmptyStateImageDataUrls([]);
  const removeDraftImage = (index: number) => {
    setDraftImageDataUrls((current) => current.filter((_, candidateIndex) => candidateIndex !== index));
  };
  const removeEmptyStateImage = (index: number) => {
    setEmptyStateImageDataUrls((current) =>
      current.filter((_, candidateIndex) => candidateIndex !== index),
    );
  };
  const removeLastDraftImage = () => {
    setDraftImageDataUrls((current) => current.slice(0, -1));
  };
  const removeLastEmptyStateImage = () => {
    setEmptyStateImageDataUrls((current) => current.slice(0, -1));
  };

  const handleSend = async () => {
    if (!args.selectedSummary || (!draft.trim() && draftImageDataUrls.length === 0)) {
      return;
    }
    const textDraft = draft;
    const imageDraft = [...draftImageDataUrls];
    const text = appendImageDataUrlsToText(textDraft, imageDraft);
    const sessionId = args.selectedSummary.session.id;
    setDraft("");
    setDraftImageDataUrls([]);
    pendingSendCountRef.current += 1;
    setSendPending(true);
    const sendTask = async () => {
      try {
        await args.sendInput(sessionId, text);
      } catch {
        setDraft((current) => (current.trim() ? current : textDraft));
        setDraftImageDataUrls((current) => (current.length > 0 ? current : imageDraft));
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
    const textDraft = emptyStateDraft;
    const imageDraft = [...emptyStateImageDataUrls];
    const text = appendImageDataUrlsToText(textDraft, imageDraft);
    if (!text || !args.availableWorkspaceDir) {
      return;
    }
    setEmptyStateDraft("");
    setEmptyStateImageDataUrls([]);
    const title = textDraft.trim() ? textDraft.trim().slice(0, 50) : "Image prompt";
    void args
      .startSession({
        provider: args.newSessionProvider,
        cwd: args.availableWorkspaceDir,
        title,
        initialInput: text,
        ...(args.startModeId ? { modeId: args.startModeId } : {}),
        ...(args.startModelId ? { model: args.startModelId } : {}),
        ...(args.startOptionValues ? { optionValues: args.startOptionValues } : {}),
        ...(args.startReasoningId ? { reasoningId: args.startReasoningId } : {}),
        ...(args.confirmCreateMissingWorkspace
          ? { confirmCreateMissingWorkspace: args.confirmCreateMissingWorkspace }
          : {}),
      })
      .catch(() => {
        setEmptyStateDraft((current) => (current.trim() ? current : textDraft));
        setEmptyStateImageDataUrls((current) => (current.length > 0 ? current : imageDraft));
      });
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

  return {
    composerRef,
    draft,
    draftImageDataUrls,
    draftImageCount: draftImageDataUrls.length,
    emptyStateComposerRef,
    emptyStateDraft,
    emptyStateImageDataUrls,
    emptyStateImageCount: emptyStateImageDataUrls.length,
    sendPending,
    setDraft,
    setEmptyStateDraft,
    handleDraftPaste,
    handleEmptyStatePaste,
    clearDraftImages,
    clearEmptyStateImages,
    removeDraftImage,
    removeEmptyStateImage,
    removeLastDraftImage,
    removeLastEmptyStateImage,
    handleSend,
    handleEmptyStateSend,
    insertDraftReference,
    insertEmptyStateReference,
  };
}
