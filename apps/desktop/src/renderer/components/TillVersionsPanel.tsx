/**
 * TillVersionsPanel — A443: on the branch server, the version it holds for its tills and what each till runs.
 *
 * Owner, 2026-10-11: "make the server update tills like hey here is the new version please ensure all of us are having
 * it; if the till is off and comes online it can request from the server or the server asks which version its running".
 * Each till asks the server every 2 minutes (and when it starts); the server lists what each said. A till behind the
 * version the server holds fetches it from the server and installs when it is next closed (or "Install now").
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

type Data = Awaited<ReturnType<typeof posApi.serverJoin.tillVersions>>;

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export default function TillVersionsPanel() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    const load = () => { posApi.serverJoin.tillVersions().then(setData).catch(() => { /* not a server */ }); };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!data) return null;
  const behind = data.tills.filter((t) => !t.current).length;
  return (
    <div data-testid="till-versions" className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-medium">Tills on this server</h3>
        <span className="text-xs text-gray-400">This server: v{data.serverVersion}</span>
      </div>
      <p className="text-xs text-gray-400">
        {data.ready
          ? `Holding v${data.ready} for the tills — each takes it from here and installs it when it is next closed.`
          : 'No update is waiting. When one is approved, this server fetches it once and the tills take it from here.'}
      </p>
      {data.tills.length === 0
        ? <p className="text-xs text-gray-500">No till has checked in yet (each asks every 2 minutes).</p>
        : (
          <ul className="divide-y divide-gray-800">
            {data.tills.map((t) => (
              <li key={t.deviceId} className="flex items-center justify-between py-1.5">
                <span className="text-gray-200">{t.name || t.deviceId.slice(0, 8)}</span>
                <span className="text-xs">
                  <span className={t.current ? 'text-gray-300' : 'text-amber-300'}>v{t.version}{t.current ? '' : ' — updating'}</span>
                  <span className="text-gray-500"> · {ago(t.seenAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      {behind > 0 && <p className="text-xs text-amber-300">{behind} till{behind === 1 ? ' is' : 's are'} not on v{data.ready ?? data.serverVersion} yet.</p>}
    </div>
  );
}
