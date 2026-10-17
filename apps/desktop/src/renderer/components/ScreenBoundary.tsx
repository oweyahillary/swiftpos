/**
 * ScreenBoundary — A519 (A517 follow-up): a screen whose chunk could not load says so, instead of a blank screen.
 *
 * Since A517 the manager screens, the Tech page, setup, enrolment and help are their own chunks, loaded when opened. A
 * missing or damaged chunk (a bad update, a disk error) made React.lazy throw and, with no boundary, the whole window
 * went blank. Around every lazy screen (App.tsx <Lazy>): "This screen could not load" — Retry (imports the chunk again,
 * lib/retryLazy; a second failure reloads the window, which loads every file afresh) and, where there is somewhere to go
 * back to, "Back to the till" (the POS, or the PIN screen). Logged through the renderer error forwarding (log:renderer).
 */
import { Component, type ReactNode } from 'react';
import { resetFailedScreens } from '../lib/retryLazy';

export interface ScreenBoundaryProps {
  /** Which screen (for the log line). */
  name: string;
  /** "Back to the till" — absent where there is nowhere to go back to (setup, enrolment). */
  onBack?: () => void;
  backLabel?: string;
  overlay?: boolean;
  children?: ReactNode;
  /** Tests: the window reload stand-in. */
  reload?: () => void;
}

interface State { error: string | null; tries: number }

/** The log line for a screen that could not load. */
export function screenFailLine(name: string, error: unknown): string {
  const msg = error instanceof Error ? (error.message || error.name) : String(error);
  return `A519: the ${name} screen could not load — ${msg}`.slice(0, 500);
}

/** Forward to main's log (log:renderer) — never throws. */
export function logScreenFailure(name: string, error: unknown): void {
  try { (globalThis as any).window?.swiftpos?.logError?.(screenFailLine(name, error)); } catch { /* never break the screen */ }
}

/** The fallback itself (exported so the tests render it). */
export function ScreenLoadFailed({ onRetry, onBack, backLabel = 'Back to the till', overlay = false, again = false }: {
  onRetry: () => void; onBack?: () => void; backLabel?: string; overlay?: boolean; again?: boolean;
}) {
  return (
    <div role="alert" data-testid="screen-load-failed"
      className={`${overlay ? 'fixed inset-0 z-50 bg-gray-950/90' : 'min-h-screen bg-gray-950'} flex items-center justify-center p-6`}>
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-sm w-full text-center space-y-4">
        <p className="text-white text-lg font-semibold">This screen could not load</p>
        <p className="text-gray-400 text-sm">
          {again ? 'It failed again — Retry reloads ZapTill’s screens (you will sign in again; nothing is lost).'
            : 'Your sales and the till are fine. Try again, or go back.'}
        </p>
        <div className="flex gap-2 justify-center">
          <button onClick={onRetry} data-testid="screen-retry"
            className="px-4 py-2 rounded-xl bg-action-500 text-gray-950 font-semibold text-sm">Retry</button>
          {onBack && (
            <button onClick={onBack} data-testid="screen-back"
              className="px-4 py-2 rounded-xl bg-gray-800 text-gray-200 text-sm">{backLabel}</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default class ScreenBoundary extends Component<ScreenBoundaryProps, State> {
  state: State = { error: null, tries: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? (error.message || 'failed') : String(error || 'failed') };
  }

  componentDidCatch(error: unknown): void { logScreenFailure(this.props.name, error); }

  retry = (): void => {
    if (this.state.tries >= 1) {
      // The same chunk failed twice in this window — the browser may keep the failed module; load every file afresh.
      (this.props.reload ?? (() => window.location.reload()))();
      return;
    }
    resetFailedScreens();
    this.setState((s) => ({ error: null, tries: s.tries + 1 }));
  };

  back = (): void => {
    resetFailedScreens();   // the next time it is opened, the chunk is imported again
    this.setState({ error: null });
    this.props.onBack?.();
  };

  render(): ReactNode {
    if (this.state.error === null) return this.props.children ?? null;
    return <ScreenLoadFailed onRetry={this.retry} onBack={this.props.onBack ? this.back : undefined}
      backLabel={this.props.backLabel} overlay={this.props.overlay} again={this.state.tries >= 1} />;
  }
}
