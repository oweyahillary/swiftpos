import { useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';

/**
 * UpdateBanner — A306. A non-blocking bar that tells staff an update is happening, so the till
 * never silently vanishes-and-reappears mid-service. Shows "Downloading…" while it fetches and
 * "Update ready" once downloaded (the update installs automatically on the next normal close).
 *
 * A519 (owner, 2026-10-16, a manager on 1.0.15 asked for a PIN: "its either we make it possible to restart without the
 * pin or we remove the ability totally … not needed pin confirmation and you are the manager"): no PIN box any more.
 * The person signed in who is back office (manager, supervisor, owner — lib/access backOffice, the A499 rule) sees ONE
 * button, "Restart & update now", which installs at once (update:installNow — main checks the same rule, and uses A509's
 * updater task where present); the installer progress is VISIBLE and ZapTill relaunches. Anyone else (a cashier, a
 * waiter) sees no button: the bar only says the update installs when ZapTill is closed, or by itself when the till is
 * idle (A508). Nothing is switched: the person signed in stays signed in (A490). A restart closes no shift and no day.
 *
 * Gentle reminder (owner decision): "Later" only hides it for a while; it re-surfaces after
 * REMIND_AFTER_MS so a ready update isn't forgotten.
 *
 * 0.6.24 (owner: "make the update banner not block user activity"): the bar no longer floats over the page. It
 * publishes its height as --update-banner-h and the working screens (.app-screen) shrink by that much, so nothing —
 * the Close Day button, the cart's Pay button — sits under it. It stays below modals (z-40), which keep the full screen.
 */

const REMIND_AFTER_MS = 2 * 60 * 60 * 1000; // re-surface a dismissed "ready" banner after 2h

interface Props {
  branchId: string | null;
  /** A519: the signed-in person is back office (lib/access backOffice) — the one-tap restart. Default: no button. */
  canRestart?: boolean;
}

type Status = { state: string; version: string | null; percent: number | null };

export default function UpdateBanner({ canRestart = false }: Props) {
  const [status, setStatus] = useState<Status>({ state: 'idle', version: null, percent: null });
  const [dismissed, setDismissed] = useState(false);
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

  // A519: one tap, no PIN — main allows it only for a back-office person (or a technician).
  const restartNow = async () => {
    setMsg(''); setBusy(true);
    try {
      const r = await posApi.update.installNow();   // visible installer progress + relaunch
      if (!r.ok) setMsg(r.reason === 'manager_required' ? 'Only a manager can restart the till for the update.' : `Cannot install now: ${r.reason ?? 'unknown'}`);
    } catch (e: any) {
      setMsg(e?.message ?? 'Cannot install now.');
    } finally {
      setBusy(false);
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
          <span className="flex-1">ZapTill {status.version ?? ''} installs when ZapTill is closed, or by itself when the till is idle.</span>
          {canRestart && (
            <button onClick={restartNow} disabled={busy} data-testid="update-restart-now"
                    className="bg-action-700 hover:bg-action-600 disabled:opacity-40 rounded-lg px-3 py-1.5">
              Restart &amp; update now
            </button>
          )}
          <button onClick={() => setDismissed(true)} className="text-gray-400 hover:text-gray-200 px-2">Later</button>
          {msg && <span className="text-amber-400">{msg}</span>}
        </>
      )}
    </div>
  );
}
