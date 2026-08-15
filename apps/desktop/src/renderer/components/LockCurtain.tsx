import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

/**
 * LockCurtain — what the till shows when nobody is there.
 *
 * ── IT IS A CURTAIN, NOT A RESET ─────────────────────────────────────────────
 * This renders OVER the screen. It does not unmount POSPage or ManagerPage, does
 * not clear the staff session, and does not touch SQLite. The cart, the
 * part-entered payment, the tab you were on — all still mounted behind it. PIN
 * back in and the till is exactly where it was.
 *
 * That is what makes "lock and lose the sale" impossible rather than merely
 * unlikely: there is no code path that discards anything, so there is nothing to
 * get wrong later. Compare `handleEndShift` in App.tsx, which DOES clear the
 * staff session — deliberately a different action, reached only by the Lock till
 * button a human presses.
 *
 * ── UNLOCK IS THE PIN PAD, NOT THE OWNER LOGIN ───────────────────────────────
 * The PIN is verified through the same path as PinPage, which falls back to the
 * offline cache (`staff_pin_cache`, 14 days). If this screen demanded the owner
 * email login instead, a shop with no internet would be locked out of its own
 * till by its own screensaver — register A17 arriving through a door we built.
 *
 * Only the staff member who is signed in can dismiss it. A different cashier
 * needs Lock till, which ends the shift properly.
 */
export default function LockCurtain({
  staffName,
  staffId,
  branchId,
  onUnlock,
}: {
  staffName: string;
  staffId: string;
  branchId: string;
  onUnlock: () => void;
}) {
  const [pin, setPin]         = useState('');
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState(false);

  // Focus is taken by the hidden input so a physical keypad works without the
  // cashier having to click first — tills are often used keyboard-only.
  useEffect(() => {
    const el = document.getElementById('lock-pin-input');
    el?.focus();
  }, []);

  const submit = async (value: string) => {
    if (busy || value.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      // The SAME call PinPage makes, deliberately — it already carries the
      // offline fallback (staff_pin_cache, 14 days) and the server's revocation
      // and PERMISSIONS_CHANGED handling. A bespoke "just check this one PIN"
      // path would be a second thing that must agree with the first, which is
      // the seam this codebase keeps getting bitten by (§L).
      const session = await posApi.auth.verifyPin(value, branchId);

      // A correct PIN belonging to SOMEONE ELSE must not lift this curtain. It
      // would silently continue the locked cashier's shift under another
      // person's identity — every order still attributed to the first. Ending a
      // shift is Lock till's job, and it is one button away.
      if (session?.staff?.id === staffId) {
        await posApi.idle.clear();
        onUnlock();
        return;
      }
      setError(session ? `That is not ${staffName}'s PIN` : 'Wrong PIN');
      setPin('');
    } catch {
      // Offline with nothing cached is a real state, and saying "wrong PIN"
      // would send a manager hunting for a password problem that is really a
      // connectivity one.
      setError('Cannot check that PIN right now. Use Lock till and sign in again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  // No auto-submit. With variable-length PINs (4–6) the pad cannot know when a
  // shorter PIN is complete, so submitting at 4 truncated every 5–6 digit PIN
  // to its first four and locked those staff out (the reported manager lockout).
  // Enter or the OK key submits — the SAME interaction PinPage already uses, so
  // a cashier's muscle memory carries over.
  const press = (d: string) => {
    setPin(p => (p + d).slice(0, 6));
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-gray-950/98 backdrop-blur-sm flex items-center justify-center">
      <div className="w-full max-w-xs px-6 text-center">
        <div className="mb-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gray-900 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2" className="text-gray-400">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-white">Till locked</h1>
          {/* Naming who is still signed in matters: it tells the next person
              whether they can PIN in here or need Lock till, without making
              them guess and fail twice. */}
          <p className="text-sm text-gray-400 mt-1">
            Enter {staffName}&apos;s PIN to continue
          </p>
          <p className="text-xs text-gray-600 mt-3">
            Nothing was lost — the screen is exactly as you left it.
          </p>
        </div>

        <input
          id="lock-pin-input"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={e => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
          }}
          onKeyDown={e => { if (e.key === 'Enter') void submit(pin); }}
          className="sr-only"
          autoComplete="off"
        />

        <div className="flex justify-center gap-3 mb-8">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i}
                 className={`w-3 h-3 rounded-full transition-colors ${
                   i < pin.length ? 'bg-green-400' : 'bg-gray-800'
                 }`} />
          ))}
        </div>

        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

        <div className="grid grid-cols-3 gap-3">
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} onClick={() => press(d)} disabled={busy}
              className="h-14 rounded-xl bg-gray-900 text-white text-lg font-medium
                         hover:bg-gray-800 active:bg-gray-700 disabled:opacity-40">
              {d}
            </button>
          ))}
          <button onClick={() => void submit(pin)} disabled={busy || pin.length < 4}
            className="h-14 rounded-xl bg-green-600 text-white text-lg font-medium
                       hover:bg-green-500 active:bg-green-700 disabled:opacity-40
                       disabled:cursor-not-allowed">
            OK
          </button>
          <button onClick={() => press('0')} disabled={busy}
            className="h-14 rounded-xl bg-gray-900 text-white text-lg font-medium
                       hover:bg-gray-800 active:bg-gray-700 disabled:opacity-40">
            0
          </button>
          <button onClick={() => { setPin(''); setError(null); }} disabled={busy}
            className="h-14 rounded-xl bg-gray-900 text-gray-400
                       hover:bg-gray-800 active:bg-gray-700 disabled:opacity-40">
            ⌫
          </button>
        </div>
      </div>
    </div>
  );
}
