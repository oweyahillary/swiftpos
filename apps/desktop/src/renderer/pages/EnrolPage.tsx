import { useEffect, useState } from 'react';
import { posApi, type FoundServer } from '../lib/posApi';
import JoinWaitPanel from '../components/JoinWaitPanel';   // A436

// EnrolPage — A158/A415. A till joins its business ONLY with a one-time enrolment code
// ZapTill issues in the admin portal — never anyone's email/password — and the
// session it gets is the till's own (its device, the business, the branch; no
// person). This is the screen a CONFIGURED-but-session-less terminal shows:
// first-run install is handled by InstallPage. A till that already has its data
// is rejoined from the technician console instead (Rejoin this till), which keeps it.
//
// A436 (found 2026-10-10; owner: "proceed — on the till a message should tell the technician to accept on the
// server"): "Find the branch server" — the till asks the branch server on this network, the way a new till does
// (A427), and once someone there presses Allow it joins its business again KEEPING everything on it. While it waits
// it says to go to the server and press Allow (JoinWaitPanel).

interface Props {
  onComplete: () => void;
}

const inputCls =
  'w-full bg-[#0f172a] border border-[#1e293b] rounded-xl px-4 py-3 text-white placeholder-[#334155] ' +
  'focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/30 transition-all text-sm';

export default function EnrolPage({ onComplete }: Props) {
  const [businessId, setBusinessId] = useState('');
  const [code, setCode]             = useState('');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  // A436: the branch server route.
  const [searching, setSearching]   = useState(false);
  const [servers, setServers]       = useState<FoundServer[] | null>(null);
  const [joinTarget, setJoinTarget] = useState<FoundServer | null>(null);
  const [joinWait, setJoinWait]     = useState<{ tillName: string; at: number; code?: string | null } | null>(null);
  const [joinNote, setJoinNote]     = useState('');

  const findServer = async () => {
    setSearching(true); setJoinNote(''); setServers(null);
    let list: FoundServer[] = [];
    try { list = await posApi.install.findServers(); } catch { list = []; }
    setServers(list); setSearching(false);
    if (list.length === 0) setJoinNote('No branch server answered on this network. Check the server computer is on and ZapTill is running there, or enter a code below.');
  };

  const askToJoin = async (srv: FoundServer) => {
    setJoinNote(''); setError('');
    try {
      const r = await posApi.install.requestJoin(srv.url, true);
      setJoinTarget(srv);
      setJoinWait({ tillName: r.name, at: Date.now(), code: r.securityCode ?? null });   // A489
    } catch (e: any) { setJoinNote(e?.message ?? 'Could not ask that server.'); }
  };

  // While waiting: ask every 2 seconds; allowed → this till has joined again, on to sign-in.
  useEffect(() => {
    if (!joinTarget) return;
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const st = await posApi.install.joinStatus();
        if (st.status === 'denied') { setJoinTarget(null); setJoinNote('The server did not allow this till to join.'); }
        else if (st.status === 'expired' || st.status === 'none') { setJoinTarget(null); setJoinNote('The request ran out — ask again.'); }
        else if (st.status === 'joined') { setJoinTarget(null); onComplete(); }
      } catch (e: any) { setJoinTarget(null); setJoinNote(e?.message ?? 'Joining failed — ask again.'); }
      finally { busy = false; }
    }, 2000);
    return () => clearInterval(t);
  }, [joinTarget]);   // eslint-disable-line react-hooks/exhaustive-deps

  const handleEnrol = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!businessId.trim() || !code.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await posApi.auth.redeemEnrolment(businessId.trim(), code.trim());
      onComplete();
    } catch (err: any) {
      setError(err?.message ?? 'Enrolment failed — check the business ID and the code.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#080c14] flex items-center justify-center px-4">

      {/* Background grid */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(59,130,246,0.03) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(59,130,246,0.03) 1px, transparent 1px)`,
          backgroundSize: '48px 48px',
        }}
      />

      <div className="w-full max-w-sm relative">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-[#22c55e] flex items-center justify-center text-[#0f172a] font-black text-sm">Z</div>
            <span className="text-xl font-bold text-white tracking-tight">ZapTill</span>
          </div>
          <p className="text-[#334155] text-sm">Activate this terminal</p>
        </div>

        {/* A436: join through the branch server on this network — someone there presses Allow. */}
        <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-6 shadow-2xl mb-4" data-testid="enrol-find-server">
          <p className="text-white text-sm font-semibold">Join through the branch server</p>
          <p className="text-[#64748b] text-xs leading-relaxed mt-1">
            No code needed: this till asks the branch server on this network, and someone at the server presses Allow.
            Everything on this till is kept.
          </p>
          {servers && servers.length > 0 && !joinTarget && (
            <div className="mt-3 space-y-2">
              {servers.map((srv) => (
                <button key={srv.url} type="button" onClick={() => askToJoin(srv)}
                  className="w-full text-left rounded-xl border border-[#1e293b] bg-[#0f172a] hover:border-[#3b82f6] px-4 py-3">
                  <div className="font-semibold text-white text-sm">{srv.business ?? 'ZapTill branch server'}</div>
                  <div className="text-xs text-[#64748b] mt-0.5">{srv.server ?? 'Branch server'} · {srv.ip}</div>
                </button>
              ))}
            </div>
          )}
          {joinTarget && joinWait && <JoinWaitPanel tillName={joinWait.tillName} srv={joinTarget} askedAt={joinWait.at} securityCode={joinWait.code} />}
          {joinNote && <p className="text-sm mt-3 rounded-lg px-3 py-2 border text-amber-300 bg-amber-400/10 border-amber-400/20">{joinNote}</p>}
          {!joinTarget && (
            <button type="button" onClick={findServer} disabled={searching} data-testid="enrol-find-server-btn"
              className="mt-3 w-full py-2.5 rounded-xl text-sm font-semibold bg-[#1e293b] hover:bg-[#334155] text-white disabled:opacity-40">
              {searching ? 'Looking for the branch server…' : servers ? 'Search again' : 'Find the branch server'}
            </button>
          )}
        </div>

        <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-8 shadow-2xl">
          <form onSubmit={handleEnrol} className="space-y-5">

            <p className="text-[#64748b] text-xs leading-relaxed">
              Enter the business ID and the one-time enrolment code from ZapTill.
              The till signs in as itself — no one's password is used here.
            </p>

            <div>
              <label className="block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase">Business ID</label>
              <input
                className={inputCls}
                type="text"
                required
                placeholder="business id"
                value={businessId}
                onChange={e => setBusinessId(e.target.value)}
                autoFocus
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase">Enrolment code</label>
              <input
                className={inputCls + ' font-mono tracking-wider'}
                type="text"
                required
                placeholder="XXXX-XXXX"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !businessId.trim() || !code.trim()}
              className="w-full py-3 rounded-xl font-bold text-sm bg-[#3b82f6] hover:bg-[#2563eb] text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Activating…
                </>
              ) : 'Activate'}
            </button>
          </form>
        </div>

        <p className="text-center text-[#1e293b] text-xs mt-6">
          ZapTill v{posApi.version} · {posApi.platform} · offline-first terminal
        </p>
      </div>
    </div>
  );
}
