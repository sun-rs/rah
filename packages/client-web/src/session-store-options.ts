import type {
  SessionConfigValue,
  SessionInputAnnotation,
  SessionInputAttachment,
} from "@rah/runtime-protocol";
import type { ProviderChoice } from "./components/ProviderSelector";

export type { ProviderChoice };

export interface StartSessionOptions {
  provider?: ProviderChoice;
  cwd?: string;
  title?: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string;
  modeId?: string;
  initialInput?: string;
  initialAttachments?: SessionInputAttachment[];
  initialAnnotations?: SessionInputAnnotation[];
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  onSessionCreated?: (sessionId: string) => void;
}

export interface ResumeHistorySessionOptions {
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  modeId?: string;
  modelId?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string | null;
  initialInput?: string;
  initialAttachments?: SessionInputAttachment[];
  initialAnnotations?: SessionInputAnnotation[];
}

export interface StoredHistoryActivationOptions {
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  suppressGlobalError?: boolean;
}

export interface ResumeStoredSessionOptions extends StoredHistoryActivationOptions {
  preferStoredReplay?: boolean;
  historyReplay?: "include" | "skip";
}
