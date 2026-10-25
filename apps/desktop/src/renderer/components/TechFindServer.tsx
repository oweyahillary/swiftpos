/**
 * TechFindServer — A502: on the Tech page, the ONE way a till is pointed at a branch server — found on this network and
 * allowed at the server ("Find my server"), never an address typed in.
 *
 * Owner, 2026-10-15: "yes we remove the address totally and use find my server". The typed address let a till be pointed
 * at any machine, and since A496 the server refuses a till it was never asked to allow. This is the rejoin route the
 * sign-in-code screen already uses (A436): the till asks the server, someone there presses Allow, and only the way to the
 * server changes — sales waiting to sync, shifts, the menu and settings stay. A till already joined to its server keeps
 * working as it is (the server took its tills as allowed when it first ran this build); this is for a new server, a
 * server that was replaced or promoted, or a former server stepping down to a till.
 */
import { useEffect, useState } from 'react';
import { posApi, type FoundServer } from '../lib/posApi';
import JoinWaitPanel from './JoinWaitPanel';
import ServerAddressAsk from './ServerAddressAsk';   // A507

export default function TechFindServer({ isServer, onJoined }: { isServer: boolean; onJoined: () => void }) {
  const [searching, setSearching]   = useState(false);
  const [servers, setServers]       = useState<FoundServer[] | null>(null);
  const [joinTarget, setJoinTarget] = useState<FoundServer | null>(null);
  const [joinWait, setJoinWait]     = useState<{ tillName: string; at: number; code?: string | null } | null>(null);
  const [note, setNote]             = useState<{ ok: boolean; text: string } | null>(null);

  const find = async () => {
    setSearching(true); setNote(null); setServers(null);
    let list: FoundServer[] = [];
    try { list = await posApi.install.findServers(); } catch { list = []; }
    setServers(list); setSearching(false);
    if (list.length === 0) setNote({ ok: false, text: 'No branch server answered on this network. Check the server computer is on, ZapTill is running there, and both are on the same network.' });
  };

  const ask = async (srv: FoundServer) => {
    setNote(null);
    try {
      const r = await posApi.install.requestJoin(srv.url, true);
      setJoinTarget(srv);
      setJoinWait({ tillName: r.name, at: Date.now(), code: r.securityCode ?? null });
    } catch (e: any) { setNote({ ok: false, text: e?.message ?? 'Could not ask that server.' }); }
  };

  // While waiting: ask every 2 seconds; allowed → this till now talks to that server.
  useEffect(() => {
    if (!joinTarget) return;
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const st = await posApi.install.joinStatus();
        if (st.status === 'denied') { setJoinTarget(null); setNote({ ok: false, text: 'The server did not allow this POS to join.' }); }
        else if (st.status === 'expired' || st.status === 'none') { setJoinTarget(null); setNote({ ok: false, text: 'The request ran out — ask again.' }); }
        else if (st.status === 'joined') {
          setJoinTarget(null); setServers(null);
          setNote({ ok: true, text: `Joined the branch server at ${joinTarget.ip}.${isServer ? ' This machine is now a POS.' : ''}` });
          onJoined();
        }
      } catch (e: any) { setJoinTarget(null); setNote({ ok: false, text: e?.message ?? 'Joining failed — ask again.' }); }
      finally { busy = false; }
    }, 2000);
    return () => clearInterval(t);
  }, [joinTarget]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div data-testid="tech-find-server" className="space-y-2">
      <p className="text-[11px] text-gray-400">
        {isServer
          ? 'To make this machine a POS of another branch server: find that server, then press Allow there. This machine stops serving.'
          : 'To join this POS to a branch server (a new one, or one that replaced the old): find it, then press Allow on the server. Nothing on this POS is cleared.'}
      </p>
      <button onClick={find} disabled={searching || !!joinTarget}
        className="w-full bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm">
        {searching ? 'Looking for the branch server…' : 'Find my server'}
      </button>
      {servers && servers.length > 0 && !joinTarget && (
        <div className="space-y-1.5">
          {servers.map((srv) => (
            <button key={srv.url} onClick={() => ask(srv)}
              className="w-full text-left rounded-lg border border-gray-700 bg-[#0a0f1c] hover:border-action-500 px-3 py-2">
              <div className="text-sm text-white">{srv.business ?? 'ZapTill branch server'}</div>
              <div className="text-[11px] text-gray-400">{srv.server ?? 'Branch server'} · {srv.ip}</div>
            </button>
          ))}
        </div>
      )}
      {/* A507: found nothing (a Public network, Wi-Fi that keeps devices apart) — ask a server by its address instead. */}
      {servers && servers.length === 0 && !joinTarget && <ServerAddressAsk onAsk={ask} dark />}
      {joinTarget && joinWait && <JoinWaitPanel tillName={joinWait.tillName} srv={joinTarget} askedAt={joinWait.at} securityCode={joinWait.code} />}
      {note && <p className={`text-[11px] ${note.ok ? 'text-action-300' : 'text-amber-300'}`}>{note.text}</p>}
    </div>
  );
}
