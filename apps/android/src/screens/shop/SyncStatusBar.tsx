/**
 * SyncStatusBar — Till stage 2 (docs/ANDROID-APP-DESIGN.md §5 "a status bar: online/offline, sales waiting, last
 * synced; refusals visible to managers"). A thin strip the Shop POS shows while selling. It reads the buffer's status
 * (shop/buffer.ts → @zaptill/core/tillBuffer.bufferStatus) and the live online state, and never shows a partial total.
 *
 * Mounted by the ShopPos entry once the Stage 2 buffer is wired; harmless before then (it just shows "Online"). Polls on
 * a short timer rather than holding a subscription, so it reflects the queue draining as replay (shop/replay.ts) runs.
 */
import { useEffect, useState } from 'react';
import type { BufferStatus } from '@zaptill/core/tillBuffer';
import { type BufferStore, status as bufferStatusOf } from '../../shop/buffer';
import { useOnline } from '../../shop/connection';

const EMPTY: BufferStatus = { online: true, salesWaiting: 0, stuck: 0, oldestPending: null, lastSynced: null };

/** "14:32" in the tablet's local time, or null. */
function hhmm(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function SyncStatusBar({ store, pollMs = 4000 }: { store: BufferStore; pollMs?: number }) {
  const online = useOnline();
  const [st, setSt] = useState<BufferStatus>(EMPTY);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const s = await bufferStatusOf(store, online); if (live) setSt(s); } catch { /* keep the last */ }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, pollMs);
    return () => { live = false; clearInterval(timer); };
  }, [store, online, pollMs]);

  const waiting = st.salesWaiting;
  const last = hhmm(st.lastSynced);
  const mode = online ? (waiting > 0 ? 'syncing' : 'online') : 'offline';

  // Nothing to say when online and the queue is empty — stay out of the way.
  if (mode === 'online' && st.stuck === 0) return null;

  return (
    <div className={`sync-bar sync-${mode}`} role="status" aria-live="polite" data-testid="sync-status-bar">
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-text">
        {mode === 'offline' && 'Offline — sales are saved and will sync'}
        {mode === 'syncing' && `Syncing… ${waiting} sale${waiting === 1 ? '' : 's'} waiting`}
        {mode === 'online' && 'Online'}
      </span>
      {waiting > 0 && mode === 'offline' && <span className="sync-count">{waiting} waiting</span>}
      {last && <span className="sync-last">Last synced {last}</span>}
      {st.stuck > 0 && <span className="sync-stuck" data-testid="sync-stuck">{st.stuck} need attention</span>}
    </div>
  );
}
