import { Component, type ErrorInfo, type ReactNode } from "react";

type WorkbenchErrorBoundaryProps = {
  resetKey: string;
  children: ReactNode;
};

type WorkbenchErrorBoundaryState = {
  error: Error | null;
};

export class WorkbenchErrorBoundary extends Component<
  WorkbenchErrorBoundaryProps,
  WorkbenchErrorBoundaryState
> {
  state: WorkbenchErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): WorkbenchErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Workbench pane render failed", error, errorInfo);
  }

  componentDidUpdate(prevProps: WorkbenchErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background px-6 text-center">
          <div className="max-w-md space-y-3">
            <div className="text-base font-medium text-[var(--app-fg)]">
              This session view crashed
            </div>
            <div className="text-sm text-[var(--app-hint)]">
              {this.state.error.message || "Unknown rendering error."}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
