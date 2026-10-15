import { useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';

/**
 * UpdateBanner — A306. A non-blocking bar that tells staff an update is happening, so the till
 * never silently vanishes-and-reappears mid-service. Shows "Downloading…" while it fetches and
 * "Update ready" once downloaded (the update installs automatically on the next normal close).
 *
 * "Restart & update now" is gated to a PIN (owner decision): a cashier can't close the till mid-day. A490: the PIN's
 * holder must hold shifts.close_day (the owner's role always — it used to be refused here: the role-name list had no
 * owner), and the PIN is only IDENTIFIED in the main process (update:installWithPin) — the person signed in stays signed
 * in. (It went through auth:verifyPin, which signed the PIN's holder in over the cashier's session.) On a good PIN the
 * update applies with the installer progress VISIBLE and relaunches — no broken-shortcut gap.
 *
 * Gentle reminder (owner decision): "Later" only hides it for a while; it re-surfaces after
 * REMIND_AFTER_MS so a ready update isn't forgotten.
 *
 * 0.6.24 (owner: "make the update banner not block user activity"): the bar no longer floats over the page. It
 * publishes its height as --update-banner-h and the working screens (.app-screen) shrink by that much, so nothing —
 * the Close Day button, the cart's Pay button — sits under it. It stays below modals (z-40), which keep the full screen.
 */

const REMIND_AFTER_MS = 2 * 60 * 60 * 1000; // re-surface a dismissed "ready" banner after 2h

interface Props { branchId: string | null; }

type Status = { state: string; version: string | null; percent: number | null };

export default function UpdateBanner({ branchId }: Props) {
  const [status, setStatus] = useState<Status>({ state: 'idle', version: null, percent: null });
  const [dismissed, setDismissed] = useState(false);
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    posApi.update.getStatus().then(setStatus).catch(() => {});
    const off = posApi.update.onStatus(setStatus);   // push; returns its own unsubscribe
    return off;
  }, []);

  // A dismissal is temporary — the banner returns after REMIND_AFTER_MS (gentle reminder).
  useEffect(() => {
    if (!dismissed) return;
    const t = setTimeout(() => setDismissed(false), REMIND_AFTER_MS);
    return () => clearTimeout(t);
  }, [dismissed]);

  const downloading = status.state === 'downloading';
  const ready = status.state === 'downloaded';
  const shown = (downloading || ready) && !dismissed;

  // Reserve the bar's height for the page (see .app-screen in index.css); 0 whenever the bar is gone.
  useEffect(() => {
    const root = document.documentElement;
    const el = barRef.current;
    if (!shown || !el) { root.style.setProperty('--update-banner-h', '0px'); return; }
    const publish = () => root.style.setProperty('--update-banner-h', `${el.offsetHeight}px`);
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.setProperty('--update-banner-h', '0px'); };
  }, [shown]);

  if (!shown) return null;

  const restartNow = async () => {
    setMsg(''); setBusy(true);
    try {
      if (!branchId) { setMsg('No branch bound to this till.'); return; }
      // A490: identified, never signed in — the session at the till is untouched.
      const r = await posApi.update.installWithPin(pin.trim());   // visible installer progress + relaunch
      if (!r.ok) { setMsg(r.message ?? (r.reason === 'wrong_pin' ? 'PIN not recognised.' : `Cannot install: ${r.reason ?? 'unknown'}`)); return; }
    } catch (e: any) {
      setMsg(e?.message ?? 'PIN not recognised.');
    } finally {
      setBusy(false); setPin('');
    }
  };

  return (
    <div ref={barRef} data-testid="update-banner"
         className="fixed bottom-0 inset-x-0 z-40 bg-[#0d1424] border-t border-green-700/50 px-4 py-2 flex items-center gap-3 text-sm text-gray-200"
         style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}>
      {downloading ? (
        <>
          <span className="font-semibold text-green-400">Updating…</span>
          <span className="flex-1">Downloading ZapTill {status.version ?? ''}{typeof status.percent === 'number' ? ` — ${status.percent}%` : ''}. You can keep working.</span>
        </>
      ) : (
        <>
          <span className="font-semibold text-green-400">Update ready</span>
          <span className="flex-1">ZapTill {status.version ?? ''} will install automatically when you close the app.</span>
          {!pinMode ? (
            <>
              <button onClick={() => { setPinMode(true); setMsg(''); }}
                      className="bg-[#1e293b] hover:bg-[#26344b] rounded-lg px-3 py-1.5">
                Restart &amp; update now (manager)
              </button>
              <button onClick={() => setDismissed(true)} className="text-gray-400 hover:text-gray-200 px-2">Later</button>
            </>
          ) : (
            <>
              <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)}
                     placeholder="PIN (may close the day)" autoFocus
                     className="bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-3 py-1.5 w-32" />
              <button onClick={restartNow} disabled={busy || !pin.trim()}
                      className="bg-action-700 hover:bg-action-600 disabled:opacity-40 rounded-lg px-3 py-1.5">
                Confirm restart
              </button>
              <button onClick={() => { setPinMode(false); setPin(''); setMsg(''); }}
                      className="text-gray-400 hover:text-gray-200 px-2">Cancel</button>
            </>
          )}
          {msg && <span className="text-amber-400">{msg}</span>}
        </>
      )}
    </div>
  );
}
