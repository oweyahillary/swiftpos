/**
 * BranchSyncPanel — A501: on the Tech page of a till with a branch server, the till's conversation with that server,
 * channel by channel, in one compact panel — when each last worked, its last error in the server's own words, failures
 * in a row — plus what this till still owes the server (the backlog that was computed and never shown), the rows it
 * holds back from other tills, the server's version and branch, and "Retry failed records".
 *
 * Never on a cashier's screen (owner: no warnings or banners to cashiers) — the Tech page only.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { NodeSyncHealth, NodeChannelHealth } from '../lib/posApi';

const LABEL: Record<NodeChannelHealth['channel'], string> = {
  health: 'Reachable', sync: 'Send records', since: 'Receive records', poll: 'Instructions', roster: 'Staff list',
  reference: 'Menu & prices', gateway: 'Cloud via server', tls: 'Encryption',
};

/** "12 s ago", "4 min ago", "3 h ago", or "never". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

const REFUSAL: Record<string, string> = {
  // A503 (A502): no address or access code is typed any more — the way back is Find my server, on this page.
  access_code: 'The branch server refused this till\'s branch access code — join it again: Find my server, then Allow on the server.',
  device_key: 'The branch server does not recognise this till\'s device key — rejoin it from the branch server (Find my server).',
  branch: 'The branch server serves another branch than this till — sign in on this till for the server\'s branch, or point it at that branch\'s server.',
  tls: 'The branch server accepts only encrypted connections — see Shop network above.',
};

export default function BranchSyncPanel() {
  const [h, setH] = useState<NodeSyncHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => posApi.serverJoin.syncHealth().then((x) => { if (alive) setH(x); }).catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!h || h.role !== 'till') return null;

  const retry = async () => {
    setBusy(true); setNote('');
    try {
      const r = await posApi.serverJoin.retryFailed();
      setNote(`${r.requeued} record(s) offered to the branch server again · ${r.released} held-back record(s) tried again (${r.applied} applied)`);
      setH(await posApi.serverJoin.syncHealth());
    } catch (e: any) { setNote(e?.message ?? 'Could not do that.'); }
    finally { setBusy(false); }
  };

  const stuck = h.backlog.failed + h.quarantine.waiting + h.quarantine.givenUp;
  return (
    <div className="mt-3 text-[11px]" data-testid="branch-sync-panel">
      <div className="text-gray-300 font-semibold mb-1">Branch sync</div>
      {h.serverOlder && (
        <p className="text-amber-300 mb-1" data-testid="branch-sync-update-server">
          Update the branch server — it runs an older build (protocol {h.server?.protocol ?? 1}) than this till ({h.tillProtocol}).
        </p>
      )}
      {h.tillOlder && (
        <p className="text-amber-300 mb-1">Update this till — the branch server expects protocol {h.server?.min_till_protocol} or later.</p>
      )}
      {h.branch.mismatch && (
        <p className="text-red-400 mb-1" data-testid="branch-sync-branch">
          This till is set to branch <span className="font-mono">{h.branch.till}</span>; its branch server serves <span className="font-mono">{h.branch.server}</span> — the server refuses its records until they match.
        </p>
      )}
      {h.refusal && !h.branch.mismatch && <p className="text-red-400 mb-1">{REFUSAL[h.refusal.reason] ?? `The branch server refused this till (HTTP ${h.refusal.status}).`}</p>}
      {h.heard && (
        <p className="text-gray-400 mb-1">
          {h.heard.proven ? `Followed the branch server to ${h.heard.url} (the same server, proven) ${ago(h.heard.at)}.`
            : `A branch server was heard at ${h.heard.url} ${ago(h.heard.at)} — not followed (this till's connection is not encrypted); if it is this branch's server, use Find my server.`}
        </p>
      )}
      <table className="w-full">
        <tbody>
          {h.channels.map((c) => {
            const bad = c.failures > 0;
            const unused = !c.lastOkAt && !c.lastErrorAt;
            return (
              <tr key={c.channel} className="align-top">
                <td className="pr-2 py-0.5 whitespace-nowrap">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${unused ? 'bg-gray-600' : bad ? 'bg-red-500' : 'bg-green-500'}`} />
                  <span className="text-gray-300">{LABEL[c.channel]}</span>
                </td>
                <td className="pr-2 py-0.5 text-gray-400 whitespace-nowrap">{unused ? '—' : `ok ${ago(c.lastOkAt)}`}</td>
                <td className="py-0.5 text-gray-400">
                  {bad && <span className="text-red-400">{c.failures}× {c.lastStatus ? `HTTP ${c.lastStatus}: ` : ''}{c.lastError}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-gray-400 mt-1" data-testid="branch-sync-backlog">
        {/* A534 (A23): this till's own records the branch server has not yet confirmed (A501 nodeQueueDepth) */}
        Not yet confirmed by the branch server: {h.backlog.pending} of this till&apos;s records{h.backlog.oldestPendingAt ? ` (oldest ${ago(h.backlog.oldestPendingAt)})` : ''}
        {' · '}<span className={h.backlog.failed ? 'text-red-400' : ''}>{h.backlog.failed} failed{h.backlog.failedReason ? `: ${h.backlog.failedReason}` : ''}</span>
        {' · '}held back from other tills: {h.quarantine.waiting} retrying, {h.quarantine.givenUp} given up{h.quarantine.reason ? ` (${h.quarantine.reason})` : ''}
      </p>
      {h.server && (
        <p className="text-gray-500 mt-0.5">Server protocol {h.server.protocol} · this till {h.tillProtocol} · last seen {ago(h.server.seenAt)}</p>
      )}
      <button onClick={retry} disabled={busy || !stuck} data-testid="branch-sync-retry"
        className="mt-2 w-full bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-1.5 text-xs">
        {busy ? 'Retrying…' : 'Retry failed records'}
      </button>
      {note && <p className="mt-1 text-gray-400">{note}</p>}
    </div>
  );
}
