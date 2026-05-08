export type MuxPaneId = string;

export type MuxPaneState = {
  paneId: MuxPaneId;
  title: string;
  isPlugin: boolean;
  isFocused: boolean;
  isFloating: boolean;
  exited: boolean;
  held: boolean;
  exitStatus: number | null;
  rows: number;
  columns: number;
  contentRows: number;
  contentColumns: number;
  command?: string;
  cwd?: string;
  tabId?: number;
  tabName?: string;
};

export type MuxSessionState = {
  sessionName: string;
};

export type MuxPaneUpdate = {
  paneId: MuxPaneId;
  initial: boolean;
  viewport: string[];
  scrollback?: string[];
};

export type MuxPaneSubscription = {
  close: () => void;
};

export type MuxPaneSubscriptionExit = {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
};

export type CreateMuxPaneRequest = {
  sessionName: string;
  cwd: string;
  command: string;
  args?: string[];
  title?: string;
  replaceDefaultPane?: boolean;
};

export type CreateMuxPaneResult = {
  sessionName: string;
  paneId: MuxPaneId;
};

export type DumpMuxScreenOptions = {
  full?: boolean;
  ansi?: boolean;
};

export type SubscribeMuxPaneOptions = {
  scrollback?: number | "all";
  ansi?: boolean;
  onExit?: (exit: MuxPaneSubscriptionExit) => void;
};

export interface MuxRuntime {
  ensureAvailable(): Promise<void>;
  listSessions(): Promise<MuxSessionState[]>;
  createSession(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult>;
  createProviderPane(request: CreateMuxPaneRequest): Promise<CreateMuxPaneResult>;
  listPanes(sessionName: string): Promise<MuxPaneState[]>;
  dumpScreen(
    sessionName: string,
    paneId: MuxPaneId,
    options?: DumpMuxScreenOptions,
  ): Promise<string>;
  subscribePane(
    sessionName: string,
    paneId: MuxPaneId,
    onUpdate: (update: MuxPaneUpdate) => void,
    options?: SubscribeMuxPaneOptions,
  ): MuxPaneSubscription;
  writeChars(sessionName: string, paneId: MuxPaneId, text: string): Promise<void>;
  writeBytes(sessionName: string, paneId: MuxPaneId, data: string): Promise<void>;
  sendKeys(sessionName: string, paneId: MuxPaneId, keys: string[]): Promise<void>;
  closePane(sessionName: string, paneId: MuxPaneId): Promise<void>;
  killSession(sessionName: string): Promise<void>;
}
