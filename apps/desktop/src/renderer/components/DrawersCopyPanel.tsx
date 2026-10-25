/**
 * DrawersCopyPanel — A542: on the Tech page of a BRANCH SERVER, its copy of the branch's drawers (A535).
 *
 * At a branch with a server only the server asks the cloud about the branch's drawers (GET /api/pos/branch-drawers, one
 * call a beat) and its tills ask it on the shop network. main/branchDrawers.ts drawersStatus() said how that goes, but
 * nothing showed it. Here, next to A534's distribution panel: the last poll (when, and whether it got through), the
 * drawers held (open / waiting for a manager's confirmation), how many tills asked in the last hour, the push line (A531
 * liveSync), and whether the branch is on the fallback path (each till asks the cloud itself). Never on a cashier's
 * screen — the Tech page only.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { ServerDrawers } from '../lib/posApi';
import { ago } from './BranchSyncPanel';

export default function DrawersCopyPanel() {
  const [d, setD] = useState<ServerDrawers | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => posApi.serverJoin.drawersStatus().then((x) => { if (alive) setD(x); }).catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!d || d.role !== 'server') return null;
  const s = d.status;
  const failed = s.lastPollOk === false;
  return (
    <div className="mt-3 text-[11px]" data-testid="server-drawers">
      <div className="text-gray-300 font-semibold mb-1">The branch&apos;s drawers</div>
      <p className={failed ? 'text-amber-300' : 'text-gray-400'} data-testid="server-drawers-poll">
        Last ask of the cloud: {s.lastPollAt ? `${new Date(s.lastPollAt).toLocaleString()} (${ago(s.lastPollAt)}) — ${s.lastPollOk ? 'ok' : 'failed'}` : 'not yet'}
        {failed && s.error ? ` · ${s.error}` : ''}
        {` · ${s.mode}`}
      </p>
      <p className="text-gray-400 mt-0.5" data-testid="server-drawers-held">
        Held: {s.open} open, {s.awaitingConfirmation} waiting for a confirmation · {s.peersLastHour} till(s) asked in the last hour
      </p>
      <p className="text-gray-500 mt-0.5" data-testid="server-drawers-line">
        Push line: {s.channel === 'push' ? 'up (the cloud rings when a drawer changes)' : `${s.channel} — asked on the shorter beat`}
        {s.fallback ? '' : s.fresh ? '' : ' · the copy is too old to answer from — points of sale ask the cloud until the next ask'}
      </p>
      {s.fallback && (
        <p className="text-amber-300 mt-0.5" data-testid="server-drawers-fallback">
          Fallback: each POS asks the cloud about its own drawers (the cloud does not answer for the branch in one call)
          {s.fallbackUntil ? ` — tried again at ${new Date(s.fallbackUntil).toLocaleTimeString()}` : ''}.
        </p>
      )}
    </div>
  );
}
