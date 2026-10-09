/**
 * JoinPrompt — A427: on the branch server, "a till wants to join" with Allow and Deny, over whatever screen is open.
 *
 * Owner, 2026-10-09: "it should only ask if i allow it to join the server or not". Asks the main process every few
 * seconds (an empty list on any machine that is not a branch server). Allow fetches a one-time code from the cloud
 * for this branch; if that fails (no internet) the request stays and the reason is shown, so Allow can be pressed again.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

type Req = { id: string; name: string; ip: string; at: string };

export default function JoinPrompt() {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => posApi.serverJoin.requests().then((r) => { if (alive) setReqs(r ?? []); }).catch(() => {});
    void load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const r = reqs[0];
  if (!r) return null;

  const answer = async (allow: boolean) => {
    setBusy(true); setError('');
    try {
      await posApi.serverJoin.answer(r.id, allow);
      setReqs((list) => list.filter((x) => x.id !== r.id));
    } catch (e: any) { setError(e?.message ?? 'Could not answer — try again.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4" data-testid="join-prompt">
      <div className="w-full max-w-sm rounded-2xl border border-gray-700 bg-gray-900 p-6">
        <h2 className="text-lg font-semibold text-white">A till wants to join this branch server</h2>
        <p className="mt-2 text-sm text-gray-300"><span className="font-semibold text-white">{r.name}</span> at {r.ip}</p>
        <p className="mt-1 text-xs text-gray-400">Allow it only if it is a till you are setting up in this shop. It joins this branch and syncs through this server.</p>
        {reqs.length > 1 && <p className="mt-1 text-xs text-gray-400">{reqs.length - 1} more waiting after this one.</p>}
        {error && <p className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex gap-3">
          <button onClick={() => answer(false)} disabled={busy} data-testid="join-deny"
            className="flex-1 rounded-xl bg-gray-800 py-3 text-sm text-white hover:bg-gray-700 disabled:opacity-40">Deny</button>
          <button onClick={() => answer(true)} disabled={busy} data-testid="join-allow"
            className="flex-1 rounded-xl bg-action-500 py-3 text-sm font-bold text-gray-950 hover:bg-action-400 disabled:opacity-40">{busy ? 'Adding…' : 'Allow'}</button>
        </div>
      </div>
    </div>
  );
}
