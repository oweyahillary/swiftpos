import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

/**
 * UpdateBanner — A306. A non-blocking bar that tells staff an update is happening, so the till
 * never silently vanishes-and-reappears mid-service. Shows "Downloading…" while it fetches and
 * "Update ready" once downloaded (the update installs automatically on the next normal close).
 *
 * "Restart & update now" is gated to a MANAGER/TECH PIN (owner decision): a cashier can't close
 * the till mid-day. On a valid manager PIN it calls update.installNow(), which applies the update
 * with the installer progress VISIBLE and relaunches — no broken-shortcut gap.
 *
 * Gentle reminder (owner decision): "Later" only hides it for a while; it re-surfaces after
 * REMIND_AFTER_MS so a ready update isn't forgotten.
 */

// Mirrors MANAGER_ROLES in App.tsx — the restart is a manager/tech action.
const MANAGER_ROLES = ['manager', 'supervisor', 'admin', 'branch_manager'];
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
  if ((!downloading && !ready) || dismissed) return null;

  const restartNow = async () => {
    setMsg(''); setBusy(true);
    try {
      if (!branchId) { setMsg('No branch bound to this till.'); return; }
      const s = await posApi.auth.verifyPin(pin.trim(), branchId);
      if (!MANAGER_ROLES.includes((s.role ?? '').toLowerCase())) {
        setMsg('That PIN is not a manager.');
        return;
      }
      const r = await posApi.update.installNow();   // visible installer progress + relaunch
      if (!r.ok) { setMsg(r.reason === 'manager_required' ? 'A manager must be signed in to restart.' : `Cannot install: ${r.reason ?? 'unknown'}`); return; }
    } catch {
      setMsg('PIN not recognised.');
    } finally {
      setBusy(false); setPin('');
    }
  };

  return (
    <div className="fixed bottom-0 inset-x-0 z-50 bg-[#0d1424] border-t border-green-700/50 px-4 py-3 flex items-center gap-3 text-sm text-gray-200"
         style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
      {downloading ? (
        <>
          <span className="font-semibold text-green-400">Updating…</span>
          <span className="flex-1">Downloading SwiftPOS {status.version ?? ''}{typeof status.percent === 'number' ? ` — ${status.percent}%` : ''}. You can keep working.</span>
        </>
      ) : (
        <>
          <span className="font-semibold text-green-400">Update ready</span>
          <span className="flex-1">SwiftPOS {status.version ?? ''} will install automatically when you close the app.</span>
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
                     placeholder="Manager PIN" autoFocus
                     className="bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-3 py-1.5 w-32" />
              <button onClick={restartNow} disabled={busy || !pin.trim()}
                      className="bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-lg px-3 py-1.5">
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
