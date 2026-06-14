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

interface Props {
  children: ReactNode;
  /** Optional fallback — defaults to the built-in recovery screen. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error:    Error | null;
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
  }

  handleReload = () => window.location.reload();

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-4">⚠</div>
          <h1 className="text-white font-bold text-xl mb-2">Something went wrong</h1>
          <p className="text-gray-400 text-sm mb-6">
            An unexpected error occurred. Your data is safe — please reload to continue.
          </p>
          {process.env.NODE_ENV !== 'production' && this.state.error && (
            <pre className="text-left text-red-400 text-xs bg-gray-950 rounded-lg p-3 mb-6 overflow-auto max-h-40">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            className="bg-green-500 hover:bg-green-400 text-gray-950 font-bold rounded-xl px-6 py-2.5 text-sm transition-colors"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
