import { Component, type ErrorInfo, type ReactNode } from "react";

type FilePreviewDialogErrorBoundaryProps = {
  resetKey: string;
  presentation?: "floating" | "pane" | "pane-window";
  onClose: () => void;
  children: ReactNode;
};

type FilePreviewDialogErrorBoundaryState = {
  error: Error | null;
};

export class FilePreviewDialogErrorBoundary extends Component<
  FilePreviewDialogErrorBoundaryProps,
  FilePreviewDialogErrorBoundaryState
> {
  state: FilePreviewDialogErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): FilePreviewDialogErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("File preview render failed", error, errorInfo);
  }

  componentDidUpdate(prevProps: FilePreviewDialogErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <>
        {this.props.presentation === "floating" || !this.props.presentation ? (
          <div className="fixed inset-0 z-40 bg-black/45" />
        ) : null}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="File preview failed"
          className={
            this.props.presentation === "pane"
              ? "pointer-events-auto absolute inset-x-3 top-11 z-[31] flex flex-col gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-4 text-sm text-[var(--app-fg)] shadow-xl"
              : this.props.presentation === "pane-window"
                ? "pointer-events-auto absolute left-1/2 top-[calc(50%+1rem)] z-[31] flex w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-4 text-sm text-[var(--app-fg)] shadow-xl"
              : "fixed left-1/2 top-1/2 z-50 flex w-[min(30rem,88vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-4 text-sm text-[var(--app-fg)] shadow-2xl"
          }
        >
          <div>
            <div className="font-semibold">File preview failed</div>
            <div className="mt-1 text-xs text-[var(--app-hint)]">
              {this.state.error.message || "Unknown rendering error."}
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
              onClick={this.props.onClose}
            >
              Close
            </button>
          </div>
        </div>
      </>
    );
  }
}
