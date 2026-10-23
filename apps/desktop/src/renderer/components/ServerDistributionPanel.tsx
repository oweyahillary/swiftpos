/**
 * ServerDistributionPanel — A534 (register A23): on the Tech page of a BRANCH SERVER, how far its distribution to the
 * cloud is behind: how many records wait (by table — and how many of the sales are its tills'), the age of the oldest,
 * the last push the cloud took, and the runbook line a technician must see before touching a failed server.
 *
 * Owner, 2026-10-20: "add all of them since effort is small". Never on a cashier's screen — the Tech page only.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { ServerDistribution } from '../lib/posApi';
import { ago } from './BranchSyncPanel';

/** "3 h 12 min", "4 min", "40 s". */
export function age(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const h = Math.floor(ms / 3_600_000);
  if (h < 48) return `${h} h ${Math.round((ms % 3_600_000) / 60_000)} min`;
  return `${Math.round(ms / 86_400_000)} days`;
}

const LABEL: Array<[keyof Extract<ServerDistribution, { role: 'server' }>['waiting'], string]> = [
  ['orders', 'sales'], ['shifts', 'drawers'], ['days', 'days'], ['floats', 'pay-ins / pay-outs'],
  ['expenses', 'expenses'], ['kitchenVoids', 'kitchen voids'], ['reversals', 'offline voids / refunds'],
];

export default function ServerDistributionPanel() {
  const [d, setD] = useState<ServerDistribution | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => posApi.serverJoin.distribution().then((x) => { if (alive) setD(x); }).catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!d || d.role !== 'server') return null;
  const parts = LABEL.filter(([k]) => d.waiting[k] > 0)
    .map(([k, l]) => `${d.waiting[k]} ${l}${k === 'orders' && d.waiting.ordersFromTills ? ` (${d.waiting.ordersFromTills} from this branch's tills)` : ''}`);
  const late = (d.oldestAgeMs ?? 0) > 30 * 60_000;
  return (
    <div className="mt-3 text-[11px]" data-testid="server-distribution">
      <div className="text-gray-300 font-semibold mb-1">Distribution to the cloud</div>
      <p className={late ? 'text-amber-300' : 'text-gray-400'} data-testid="server-distribution-waiting">
        {d.total === 0 ? 'Nothing waits — every record on this server is on the cloud.'
          : `${d.total} record(s) not yet on the cloud: ${parts.join(', ')}${d.oldestAgeMs !== null ? ` · the oldest has waited ${age(d.oldestAgeMs)}` : ''}.`}
      </p>
      <p className="text-gray-500 mt-0.5">
        Last push the cloud took: {d.lastPushOkAt ? `${new Date(d.lastPushOkAt).toLocaleString()} (${ago(d.lastPushOkAt)})` : 'none recorded yet'}
        {d.lastSyncedAt ? ` · nothing waited at ${new Date(d.lastSyncedAt).toLocaleString()}` : ''}
      </p>
      <p className="text-amber-300 mt-1" data-testid="server-distribution-runbook">{d.runbook}</p>
    </div>
  );
}
