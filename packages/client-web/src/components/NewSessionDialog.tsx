import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, FolderPlus, Settings2, Sparkles, X } from "lucide-react";
import type { ProviderDiagnostic } from "@rah/runtime-protocol";
import * as api from "../api";
import { ProviderLogo } from "./ProviderLogo";
import { WorkspacePicker } from "./WorkspacePicker";

type ProviderChoice = "codex" | "claude" | "kimi" | "gemini" | "opencode";

const PROVIDER_OPTIONS: Array<{ value: ProviderChoice; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "kimi", label: "Kimi" },
  { value: "gemini", label: "Gemini" },
  { value: "opencode", label: "OpenCode" },
];

export function NewSessionDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceDirs: string[];
  defaultWorkspaceDir: string;
  defaultProvider: ProviderChoice;
  onCreate: (input: {
    provider: ProviderChoice;
    cwd: string;
    title?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
  }) => Promise<void>;
}) {
  const [workspaceDir, setWorkspaceDir] = useState(props.defaultWorkspaceDir);
  const [provider, setProvider] = useState<ProviderChoice>(props.defaultProvider);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState("never");
  const [sandbox, setSandbox] = useState("danger-full-access");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [providerDiagnostics, setProviderDiagnostics] = useState<ProviderDiagnostic[]>([]);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setWorkspaceDir(props.defaultWorkspaceDir);
    setProvider(props.defaultProvider);
    setTitle("");
    setModel("");
    setApprovalPolicy("never");
    setSandbox("danger-full-access");
    setIsSubmitting(false);
  }, [props.defaultProvider, props.defaultWorkspaceDir, props.open]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setDiagnosticsLoading(true);
    void api
      .listProviders()
      .then((providers) => setProviderDiagnostics(providers))
      .catch(() => setProviderDiagnostics([]))
      .finally(() => setDiagnosticsLoading(false));
  }, [props.open]);

  const workspaceOptions = useMemo(
    () => props.workspaceDirs.filter((dir) => dir.trim().length > 0),
    [props.workspaceDirs],
  );
  const selectedProviderDiagnostic =
    providerDiagnostics.find((entry) => entry.provider === provider) ?? null;

  const handleCreate = async () => {
    const cwd = workspaceDir.trim();
    if (!cwd || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    void props
      .onCreate({
        provider,
        cwd,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(provider === "codex" && model.trim() ? { model: model.trim() } : {}),
        ...(provider === "codex" ? { approvalPolicy, sandbox } : {}),
      })
      .catch(() => undefined);
    props.onOpenChange(false);
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[90vh] w-[92vw] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-50 flex flex-col">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-[var(--app-hint)]" />
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                New session
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-4 space-y-4">
            <section className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium text-[var(--app-hint)]">
                <FolderPlus size={14} />
                <span>Workspace</span>
              </div>
              {workspaceOptions.length > 0 ? (
                <select
                  className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  value={workspaceDir}
                  onChange={(event) => setWorkspaceDir(event.currentTarget.value)}
                >
                  {workspaceOptions.map((dir) => (
                    <option key={dir} value={dir}>
                      {dir}
                    </option>
                  ))}
                </select>
              ) : null}
              <WorkspacePicker
                currentDir={workspaceDir}
                triggerLabel={workspaceOptions.length > 0 ? "Browse another workspace" : "Choose workspace"}
                onSelect={setWorkspaceDir}
              />
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-medium text-[var(--app-hint)]">Provider</div>
                <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                  {PROVIDER_OPTIONS.map((option) => {
                    const selected = provider === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setProvider(option.value)}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                          selected
                            ? "border-primary bg-primary/10 text-[var(--app-fg)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_70%,transparent)]"
                            : "border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        }`}
                      >
                        <ProviderLogo provider={option.value} className="h-5 w-5" />
                        <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
                        {selected ? <Check size={14} className="shrink-0 text-primary" /> : null}
                      </button>
                    );
                  })}
                </div>
                <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                  {diagnosticsLoading ? (
                    <div>Checking provider runtime…</div>
                  ) : selectedProviderDiagnostic ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <ProviderLogo provider={provider} className="h-4 w-4" />
                          <span>Runtime status</span>
                        </div>
                        <span
                          className={
                            selectedProviderDiagnostic.status === "ready"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : selectedProviderDiagnostic.status === "missing_binary"
                                ? "text-[var(--app-warning)]"
                                : "text-[var(--app-danger)]"
                          }
                        >
                          {selectedProviderDiagnostic.status === "ready"
                            ? "Ready"
                            : selectedProviderDiagnostic.status === "missing_binary"
                              ? "Missing binary"
                              : "Launch error"}
                        </span>
                      </div>
                      <div className="truncate" title={selectedProviderDiagnostic.launchCommand}>
                        {selectedProviderDiagnostic.launchCommand || "No launch command"}
                      </div>
                      {selectedProviderDiagnostic.version ? (
                        <div className="truncate" title={selectedProviderDiagnostic.version}>
                          {selectedProviderDiagnostic.version}
                        </div>
                      ) : null}
                      {selectedProviderDiagnostic.detail ? (
                        <div className="text-[var(--app-danger)]">
                          {selectedProviderDiagnostic.detail}
                        </div>
                      ) : null}
                      <div>
                        Auth is managed by the provider CLI and is not validated here.
                      </div>
                    </div>
                  ) : (
                    <div>Provider diagnostics unavailable.</div>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-xs font-medium text-[var(--app-hint)]">Title</div>
                <input
                  className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="Optional session title"
                />
              </div>
            </section>

            {provider === "codex" ? (
              <section className="space-y-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--app-hint)]">
                  <Settings2 size={14} />
                  <span>Codex options</span>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-[var(--app-hint)]">Model</div>
                    <input
                      className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                      value={model}
                      onChange={(event) => setModel(event.currentTarget.value)}
                      placeholder="Optional model id"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-[var(--app-hint)]">Approval policy</div>
                    <select
                      className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                      value={approvalPolicy}
                      onChange={(event) => setApprovalPolicy(event.currentTarget.value)}
                    >
                      <option value="never">Auto allow</option>
                      <option value="on-request">Ask on request</option>
                    </select>
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <div className="text-xs font-medium text-[var(--app-hint)]">Sandbox</div>
                    <select
                      className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                      value={sandbox}
                      onChange={(event) => setSandbox(event.currentTarget.value)}
                    >
                      <option value="danger-full-access">Read/write</option>
                      <option value="read-only">Read only</option>
                    </select>
                  </div>
                </div>
              </section>
            ) : (
              <section className="space-y-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--app-hint)]">
                  <Settings2 size={14} />
                  <span>Provider options</span>
                </div>
                <div className="text-sm text-[var(--app-hint)]">
                  Advanced startup options are wired for Codex first. This provider currently uses
                  default startup settings.
                </div>
              </section>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[var(--app-border)] px-4 py-3">
            <div className="min-w-0 text-xs text-[var(--app-hint)] truncate">
              {workspaceDir.trim() ? `Target: ${workspaceDir}` : "Choose a workspace first"}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                disabled={!workspaceDir.trim() || isSubmitting}
                onClick={() => void handleCreate()}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-colors"
              >
                {isSubmitting ? "Creating…" : "Create session"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
