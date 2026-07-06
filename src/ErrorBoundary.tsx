import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("React render error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6 flex items-center justify-center">
          <div className="max-w-xl w-full rounded-xl border border-red-900/60 bg-red-950/30 p-5">
            <div className="text-sm font-semibold text-red-200 mb-2">界面渲染出错</div>
            <div className="text-xs text-red-100/80 whitespace-pre-wrap break-words">
              {this.state.error.message}
            </div>
            <button
              className="mt-4 px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200"
              onClick={() => this.setState({ error: null })}
            >
              重试渲染
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
