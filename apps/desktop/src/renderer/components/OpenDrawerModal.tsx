/**
 * OpenDrawerModal — the first thing a cashier sees on a till with no open drawer.
 *
 * WHY A MODAL AND NOT A BANNER
 *   This began as an amber banner, by analogy with the stale-shift notice. That
 *   was the wrong analogy. The stale-shift notice is deliberately non-blocking
 *   because it fires MID-SERVICE with a customer waiting, where stopping the till
 *   achieves nothing except teaching staff to route around the control.
 *
 *   "No drawer open" is the opposite situation. It happens at the START of a
 *   stint, Pay is disabled anyway, and there is nothing else on the screen worth
 *   doing. A banner asks the cashier to notice a message and go and find a
 *   button; a modal puts the only useful action in front of them with the field
 *   already focused. Not dismissable, because there is nothing behind it to use.
 *
 * WHY THE FLOAT IS TYPED EVERY TIME
 *   No prefill, no "same as last time". Sites move physical drawers between
 *   terminals and that cannot be controlled from here, so cash is never inferred
 *   from where a drawer sits: it is counted at open and counted at close, and each
 *   shift stands alone. Carrying a figure over would silently corrupt the
 *   reconciliation the first time a drawer moved, and it would look fine until a
 *   variance surfaced somewhere nobody could trace.
 */

import { useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';

interface Props {
  cashierName?: string;
  currency: string;
  /** Called once a drawer is open, so the POS can refresh its gate. */
  onOpened: () => void;
  /**
   * Sign out without opening a drawer.
   *
   * Necessary because this modal is not dismissable: without it, the wrong person
   * signing in — or anyone who simply meant to check something — is trapped on a
   * screen whose only exit is committing a counted float. That is the kind of
   * dead end that gets worked around by inventing a number.
   */
  onLogout: () => void;
}

export default function OpenDrawerModal({ cashierName, currency, onOpened, onLogout }: Props) {
  const [float, setFloat] = useState('');
  const [terminal, setTerminal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // The terminal identifies itself. Asking a cashier which till they are standing
  // at is asking for something the install already knows, and a hand-typed answer
  // is worse than a derived one: it can be wrong.
  useEffect(() => {
    posApi.config.identity()
      .then(d => setTerminal(d.terminalCode ?? null))
      .catch(() => setTerminal(null));
  }, []);

  const submit = async () => {
    const amount = Number(float);
    // An empty float is not the same as zero. Zero is a real answer — an empty
    // drawer — but it has to be stated, because a blank waved through as 0 is
    // how a shift starts with an unknown opening balance and can never be
    // reconciled afterwards.
    if (float.trim() === '' || !Number.isFinite(amount) || amount < 0) {
      setError('Count the cash in the drawer and enter it. Enter 0 if the drawer is empty.');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      // drawer_label is deliberately NOT sent. The shift already records
      // device_id and terminal_code, so copying the till's code into a "drawer"
      // field would be duplicate data wearing the costume of new information.
      // The column stays for a site that genuinely tracks numbered drawers moving
      // between terminals — see the note in migration 41.
      const res = await posApi.shift.open(amount);
      if ((res as any)?.error) { setError(String((res as any).error)); return; }
      onOpened();
    } catch (err: any) {
      setError(err?.message ?? 'Could not open the drawer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="px-6 pt-6 pb-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">Open your drawer</h2>
          <p className="text-sm text-gray-400 mt-1">
            {cashierName ? `${cashierName} — ` : ''}count the cash in the drawer before you start.
          </p>
          {/* Detected, not asked. Shown so the cashier can confirm which terminal
              they are at — useful when three tills sit side by side. */}
          {terminal && (
            <p className="text-xs text-gray-500 mt-1.5">
              Till <span className="text-gray-300 font-medium">{terminal}</span>
            </p>
          )}
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm text-gray-300 mb-1.5">
              Opening float ({currency})
            </label>
            <input
              ref={inputRef}
              type="number" min={0} step="0.01" inputMode="decimal"
              value={float}
              disabled={busy}
              onChange={e => { setFloat(e.target.value); setError(''); }}
              onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
              placeholder="0.00"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2.5
                         text-white text-lg tabular-nums focus:border-green-500 focus:outline-none
                         disabled:opacity-50"
            />
            <p className="text-[11px] text-gray-500 mt-1.5">
              What is physically in the drawer now — not what it should be.
            </p>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="px-6 pb-6 space-y-3">
          <button
            onClick={submit}
            disabled={busy}
            className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700
                       disabled:text-gray-500 text-white rounded-xl py-3 text-sm
                       font-semibold transition-colors"
          >
            {busy ? 'Opening…' : 'Start selling'}
          </button>

          {/* The way out. This modal cannot be dismissed, so without this the
              wrong person signing in is stuck on a screen whose only exit is
              committing a counted float — and a trapped cashier invents a number. */}
          <button
            onClick={onLogout}
            disabled={busy}
            className="w-full text-xs text-gray-400 hover:text-red-400 disabled:text-gray-600
                       py-1 transition-colors"
          >
            Not you? Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
