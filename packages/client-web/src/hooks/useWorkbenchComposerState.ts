import { useRef, useState } from "react";
import type { SessionConfigValue, SessionSummary } from "@rah/runtime-protocol";
import type { ProviderChoice } from "../components/ProviderSelector";
import { insertTextAtSelection } from "../composer-text-insertion";

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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [emptyStateDraft, setEmptyStateDraft] = useState("");
  const emptyStateComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const [sendPending, setSendPending] = useState(false);

  const handleSend = async () => {
    if (sendPending || !args.selectedSummary || !draft.trim()) {
      return;
    }
    const text = draft.trim();
    setDraft("");
    setSendPending(true);
    try {
      await args.sendInput(args.selectedSummary.session.id, text);
    } catch {
      setDraft((current) => (current.trim() ? current : text));
    } finally {
      setSendPending(false);
    }
  };

  const handleEmptyStateSend = () => {
    const text = emptyStateDraft.trim();
    if (!text || !args.availableWorkspaceDir) {
      return;
    }
    setEmptyStateDraft("");
    void args
      .startSession({
        provider: args.newSessionProvider,
        cwd: args.availableWorkspaceDir,
        title: text.slice(0, 50),
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
        setEmptyStateDraft((current) => (current.trim() ? current : text));
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
    emptyStateComposerRef,
    emptyStateDraft,
    sendPending,
    setDraft,
    setEmptyStateDraft,
    handleSend,
    handleEmptyStateSend,
    insertDraftReference,
    insertEmptyStateReference,
  };
}
