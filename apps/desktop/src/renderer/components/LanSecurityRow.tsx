/**
 * LanSecurityRow — A489: on the Tech page, whether this till's connection to its branch server is encrypted (and the
 * security code to compare with the server's), or — on the server — its own security code. When the server answers
 * with a different certificate (it was reinstalled), nothing is sent to it until a person trusts it again here.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

type Status = Awaited<ReturnType<typeof posApi.serverJoin.tlsStatus>>;

export default function LanSecurityRow() {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => posApi.serverJoin.tlsStatus().then((s) => { if (alive) setSt(s); }).catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!st || st.state === 'none') return null;

  const retrust = async () => {
    setBusy(true); setNote('');
    try {
      await posApi.serverJoin.tlsRetrust();
      setNote('Forgotten — the POS trusts the branch server\'s new certificate within a minute.');
      setSt(await posApi.serverJoin.tlsStatus());
    } catch (e: any) { setNote(e?.message ?? 'Could not do that.'); }
    finally { setBusy(false); }
  };

  const code = st.code ? <span className="font-mono text-white">{st.code}</span> : null;
  return (
    <>
      <dt className="text-gray-300">Shop network</dt>
      <dd className="text-gray-300" data-testid="lan-security">
        {st.state === 'server' && <>Encrypted for points of sale on 1.0.15 or later · security code {code}</>}
        {st.state === 'encrypted' && <>Encrypted · security code {code}</>}
        {st.state === 'plain' && <>Not encrypted yet — it switches by itself once the branch server answers encrypted</>}
        {st.state === 'old_server' && <>Not encrypted — the branch server runs an older build; update it</>}
        {st.state === 'tls_failed' && (
          <span className="text-red-400" data-testid="lan-tls-failed">
            The branch server does not answer encrypted any more — nothing is sent to it; this POS checks again every minute.
            If it was reinstalled with an older build, update it, or trust it again.
            {st.error && <span className="block text-gray-400">{st.error}</span>}{/* A503: e.g. a re-trust waiting for a certificate */}{' '}
            <button onClick={retrust} disabled={busy}
              className="ml-1 rounded bg-[#1e293b] px-2 py-0.5 text-gray-200 hover:bg-[#26344b] disabled:opacity-40">
              {busy ? 'Working…' : 'Trust it again'}
            </button>
          </span>
        )}
        {st.state === 'mismatch' && (
          <span className="text-red-400">
            {/* A503: a reinstalled server has a new access code too — trusting its certificate alone cannot reconnect. */}
            The branch server's identity changed — nothing is sent to it. If it was reinstalled, join it again (Find my
            server) and press Allow there; trust it again only if you know its certificate alone changed.{' '}
            <button onClick={retrust} disabled={busy} data-testid="lan-retrust"
              className="ml-1 rounded bg-[#1e293b] px-2 py-0.5 text-gray-200 hover:bg-[#26344b] disabled:opacity-40">
              {busy ? 'Working…' : 'Trust it again'}
            </button>
          </span>
        )}
        {note && <div className="mt-1 text-gray-400">{note}</div>}
      </dd>
    </>
  );
}
