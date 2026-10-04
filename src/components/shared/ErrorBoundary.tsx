import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export interface ErrorBoundaryProps {
  /** Human-readable name of the wrapped panel/tab, shown in the fallback UI. */
  label?: string;
  /** Custom fallback. Receives the caught error and a reset function. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** Called with the error + component stack when a crash is caught. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /**
   * When any entry changes (compared shallowly), the boundary resets itself.
   * Pass e.g. `[activeTab]` so switching tabs recovers a crashed panel.
   */
  resetKeys?: unknown[];
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Industry-standard React error boundary (class component — still the only
 * supported mechanism in React 19).
 *
 * Why this exists: Argus renders 120+ panels in one SPA. Before this, a
 * single render crash in any panel (bad API payload, chart library edge
 * case, etc.) unmounted the ENTIRE trading terminal — a white screen during
 * live trading. Boundaries are placed at the app root AND around each tab's
 * content so a crash is contained to the panel that failed, with a
 * one-click recovery that doesn't lose the rest of the session.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Never let a logging failure mask the original crash.
    try {
      console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
      this.props.onError?.(error, info);
    } catch {
      /* noop */
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    const { resetKeys } = this.props;
    if (this.state.error && resetKeys && prevProps.resetKeys) {
      const changed =
        resetKeys.length !== prevProps.resetKeys.length ||
        resetKeys.some((k, i) => !Object.is(k, prevProps.resetKeys![i]));
      if (changed) this.reset();
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <ErrorFallback label={this.props.label} error={this.state.error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function ErrorFallback({
  label,
  error,
  onReset,
}: {
  label?: string;
  error: Error;
  onReset: () => void;
}) {
  const [showDetails, setShowDetails] = React.useState(false);
  const panelName = label ?? 'panel';
  return (
    <div
      role="alert"
      data-testid="error-boundary-fallback"
      className="flex flex-col items-center justify-center gap-3 rounded-lg border border-red-500/30 bg-[#160b0e] px-6 py-10 text-center"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500/15">
        <AlertTriangle className="h-5 w-5 text-red-400" aria-hidden />
      </div>
      <div className="text-sm font-semibold text-red-200">
        {panelName} crashed
      </div>
      <p className="max-w-md text-xs leading-relaxed text-zinc-400">
        This panel hit a rendering error and was isolated so the rest of the
        terminal keeps running. Your session, positions and other tabs are
        unaffected.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/30"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reload {panelName}
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          Reload page
        </button>
      </div>
      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        className="text-[11px] text-zinc-500 underline-offset-2 hover:underline"
        aria-expanded={showDetails}
      >
        {showDetails ? 'Hide' : 'Show'} error details
      </button>
      {showDetails && (
        <pre className="max-h-40 w-full max-w-xl overflow-auto rounded bg-black/50 p-3 text-left font-mono text-[11px] text-red-300/80">
          {error.message}
          {error.stack ? `\n${error.stack.split('\n').slice(0, 6).join('\n')}` : ''}
        </pre>
      )}
    </div>
  );
}

/** Convenience wrapper for the common "label this panel" case. */
export function PanelBoundary({
  label,
  resetKeys,
  children,
}: {
  label: string;
  resetKeys?: unknown[];
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary label={label} resetKeys={resetKeys}>
      {children}
    </ErrorBoundary>
  );
}
