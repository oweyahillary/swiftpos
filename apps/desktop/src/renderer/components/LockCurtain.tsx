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
 * A446: the PIN is checked by auth:unlock — this till's own staff list and saved
 * sign-ins first (no network), then the branch server, then the cloud — and only
 * the signed-in person's PIN lifts it; nothing about the session changes. If this
 * screen demanded the owner email login instead, a shop with no internet would be
 * locked out of its own till by its own screensaver — register A17.
 *
 * Only the staff member who is signed in can dismiss it. A different cashier
 * uses "Sign out — another person signs in" (the shift stays open).
 */
export default function LockCurtain({
  staffName,
  staffId,
  branchId,
  onUnlock,
  onSignOut,
}: {
  staffName: string;
  staffId: string;
  branchId: string;
  onUnlock: () => void;
  /** A446: sign this person out to the PIN screen (the cart was theirs; another cashier signs in fresh). */
  onSignOut?: () => void;
}) {
  const [pin, setPin]         = useState('');
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState(false);
  // 0.6.24 (owner: "add the organization logo where the till is"): the client's logo, read like the PIN screen reads
  // it (branding:get, refreshed when a pull lands). None → the padlock, as before.
  const [logo, setLogo]       = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      posApi.branding.get().then((b) => { if (!cancelled) setLogo(b?.logoPng ?? null); }).catch(() => { /* keep what is shown */ });
    };
    load();
    const unsubscribe = posApi.pos.onCatalogueChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

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
      // A446 (session audit): auth:unlock — is this the signed-in person's PIN? It writes NOTHING unless it is (it used
      // to be auth:verifyPin, which re-signed in whoever's PIN it was BEFORE this screen compared: a colleague's correct PIN
      // silently made them the signed-in person behind "That is not X's PIN", and an unlock through the branch server
      // swapped a working cloud session for an offline one). Checked on this till first — no network needed.
      const r = await posApi.auth.unlock(value);
      if (r.ok) {
        await posApi.idle.clear();
        onUnlock();
        return;
      }
      setError(`That is not ${staffName}'s PIN. Try again.`);
      setPin('');
    } catch (e: any) {
      // A446 (owner's screenshot, 2026-10-11): every failure used to read "Cannot check that PIN right now. Use Lock till
      // and sign in again" — a wrong PIN included — on a screen with no Lock till button, so the app had to be closed.
      // Now the real reason (posApi words it: a wrong PIN, no connection and no saved sign-in, …), and a way out below.
      const msg = String(e?.message ?? '');
      setError(/not recognised|invalid pin/i.test(msg) ? `That is not ${staffName}'s PIN. Try again.` : (msg || 'Cannot check that PIN right now.'));
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
    // Opaque (0.6.24, owner: "the small wordings are not readable"): the old `bg-gray-950/98` is not a Tailwind opacity
    // step, so no background was generated and the blurred screen showed through the text.
    <div data-testid="lock-curtain" className="fixed inset-0 z-[9999] bg-gray-950 flex items-center justify-center">
      <div className="w-full max-w-xs px-6 text-center">
        <div className="mb-8">
          {logo ? (
            // The client's logo on a white card, as on the PIN screen (logos are made for a light background).
            <span data-testid="lock-logo" className="inline-flex items-center justify-center bg-white rounded-xl mb-4"
                  style={{ padding: '8px 10px' }}>
              <img src={logo} alt="" style={{ maxHeight: 150, maxWidth: 240, objectFit: 'contain', display: 'block' }} />
            </span>
          ) : (
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gray-900 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" className="text-gray-400">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
          )}
          <h1 className="text-xl font-semibold text-white">Till locked</h1>
          {/* Naming who is still signed in matters: it tells the next person
              whether they can PIN in here or need Lock till, without making
              them guess and fail twice. */}
          <p className="text-base text-gray-200 mt-1">
            Enter {staffName}&apos;s PIN to continue
          </p>
          <p className="text-sm text-gray-400 mt-3">
            Nothing was lost — the screen is exactly as you left it.
          </p>
        </div>

        <input
          id="lock-pin-input"
          type="password"
          // A417 (owner's screenshot, 2026-10-09): on a touch till Windows took this hidden field's focus for typing and
          // opened its own keyboard over the keypad below. "none" keeps it shut; a physical keypad still types here.
          inputMode="none"
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
                   i < pin.length ? 'bg-brand-400' : 'bg-gray-800'
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
            className="h-14 rounded-xl bg-brand-600 text-on-brand text-lg font-medium
                       hover:bg-brand-500 active:bg-brand-700 disabled:opacity-40
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
        {/* A446: the way out the old message pointed at ("Use Lock till") — a different cashier, a forgotten PIN, or a PIN
            that cannot be checked: sign out to the PIN screen. The shift stays open; an unpaid order on screen is cleared (it says so). */}
        {onSignOut && (
          <button data-testid="lock-sign-out" onClick={onSignOut} disabled={busy}
            className="mt-6 text-sm text-gray-300 hover:text-white underline underline-offset-4 disabled:opacity-40">
            Sign out — another person signs in
          </button>
        )}
        {onSignOut && (
          <p className="mt-1 text-[11px] text-gray-500">The shift stays open; an order not yet paid is cleared.</p>
        )}
      </div>
    </div>
  );
}
