/**
 * ErrorBoundary — catches uncaught React render errors and shows a
 * recovery screen instead of a blank white page.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <DashboardLayout />
 *   </ErrorBoundary>
 *
 * In development, React's overlay still appears on top — this only
 * takes over in production where the overlay isn't shown.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, reloadForNewBuild } from '../lib/staleBuild';

interface Props {
  children: ReactNode;
  /** Optional fallback — defaults to the built-in recovery screen. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error:    Error | null;
  /** A610: a page of an older build that could not load — the page reloads for the new one instead of this screen. */
  reloading?: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // In production, send to your error tracking service here
    // e.g. Sentry.captureException(error, { extra: info });
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
    // A610: a stale tab after a deploy (lib/staleBuild.ts) — load the new build once, by itself.
    if (isChunkLoadError(error) && reloadForNewBuild()) this.setState({ reloading: true });
  }

  handleReload = () => window.location.reload();

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.state.reloading) {
      return <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400 text-sm">Loading the latest version…</div>;
    }
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 max-w-md w-full text-center animate-pop-in">
          <div className="text-4xl mb-4">⚠</div>
          <h1 className="text-white font-bold text-xl mb-2">Something went wrong</h1>
          <p className="text-gray-400 text-sm mb-6">
            An unexpected error occurred. Your data is safe — please reload to continue.
          </p>
          {import.meta.env.DEV && this.state.error && (
            <pre className="text-left text-red-400 text-xs bg-gray-950 rounded-lg p-3 mb-6 overflow-auto max-h-40">
              {this.state.error.message}
            </pre>
          )}
          {/* A610: one line of what broke, so a screenshot says it (no data, just the error's own words). */}
          {!import.meta.env.DEV && this.state.error && (
            <p className="text-gray-500 text-xs mb-6 break-words" data-testid="error-detail">
              {window.location.pathname} · {(this.state.error.message || this.state.error.name || 'Error').slice(0, 160)}
            </p>
          )}
          <button
            onClick={this.handleReload}
            className="bg-action-500 hover:bg-action-400 text-gray-950 font-bold rounded-xl px-6 py-2.5 text-sm transition-colors"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
