/**
 * printRetry.ts — remember the most recent print attempt so the cashier can RETRY it after fixing the printer, without
 * re-ringing the sale.
 *
 * WHY
 * ---
 * On a Shop POS a printer that is off is said in words (shop/printing.ts → PrintNotice) and the sale is already saved, so
 * nothing is lost — but the only way to get the ticket out was to dig it up in History and reprint. When the fix is just
 * "switch the printer on", a one-tap Retry on the notice is far better. printing.ts remembers the last FAILED print here
 * (a closure that redoes exactly that print) and clears it on success; PrintNotice offers Retry while one is remembered.
 *
 * Pure (no Capacitor, no DOM) so it unit-tests on its own; printing.ts owns the single state and the native send.
 */

export interface RetryState {
  /** Redo the last failed print, or null when there is nothing to retry. */
  run: (() => Promise<void>) | null;
}

export function makeRetryState(): RetryState {
  return { run: null };
}

/** After a print FAILS, remember how to redo it. */
export function rememberRetry(state: RetryState, run: () => Promise<void>): void {
  state.run = run;
}

/** After a print SUCCEEDS (or the attempt is no longer retryable), forget it. */
export function clearRetry(state: RetryState): void {
  state.run = null;
}

/** Is there a failed print the cashier can retry? */
export function canRetry(state: RetryState): boolean {
  return state.run !== null;
}

/**
 * Redo the remembered print. No-op when nothing is remembered. The remembered closure IS the print path, so on success it
 * clears the state itself and on failure it remembers the (same) retry again — exactly as a first attempt would.
 */
export async function runRetry(state: RetryState): Promise<void> {
  const run = state.run;
  if (run) await run();
}
