import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { isLikelyStaleDynamicImportError } from "../../lazy-module-reload";

type WorkbenchErrorBoundaryProps = {
  resetKey: string;
  children: ReactNode;
  title?: string;
};

type WorkbenchErrorBoundaryState = {
  error: Error | null;
  recoveryKey: number;
};

export class WorkbenchErrorBoundary extends Component<
  WorkbenchErrorBoundaryProps,
  WorkbenchErrorBoundaryState
> {
  state: WorkbenchErrorBoundaryState = {
    error: null,
    recoveryKey: 0,
  };

  static getDerivedStateFromError(
    error: Error,
  ): Pick<WorkbenchErrorBoundaryState, "error"> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Workbench pane render failed", error, errorInfo);
  }

  componentDidUpdate(prevProps: WorkbenchErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState((current) => ({
        error: null,
        recoveryKey: current.recoveryKey + 1,
      }));
    }
  }

  private retry = () => {
    this.setState((current) => ({
      error: null,
      recoveryKey: current.recoveryKey + 1,
    }));
  };

  render() {
    if (this.state.error) {
      const staleChunkError = isLikelyStaleDynamicImportError(this.state.error);
      return (
        <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background px-6 text-center">
          <div className="max-w-md space-y-3">
            <div className="text-base font-medium text-[var(--app-fg)]">
              {this.props.title ?? "This session view crashed"}
            </div>
            <div className="text-sm text-[var(--app-hint)]">
              {staleChunkError
                ? "The web app was updated while this page was open. Reload to continue."
                : this.state.error.message || "Unknown rendering error."}
            </div>
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--app-border)] px-3 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] active:bg-[var(--app-hover)]"
              onClick={
                staleChunkError
                  ? () => window.location.reload()
                  : this.retry
              }
            >
              {staleChunkError ? "Reload" : "Retry"}
            </button>
          </div>
        </div>
      );
    }
    return (
      <Fragment key={this.state.recoveryKey}>
        {this.props.children}
      </Fragment>
    );
  }
}
