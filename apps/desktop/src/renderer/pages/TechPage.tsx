import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { TechSession, TechStatus } from '../lib/posApi';

interface Props {
  onExit: () => void;   // close session -> back to PIN pad
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export default function TechPage({ onExit }: Props) {
  const [session, setSession] = useState<TechSession | null>(null);
  const [status, setStatus] = useState<TechStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    const s = await posApi.tech.getSession();
    if (!s) { onExit(); return; }       // session expired/closed -> leave
    setSession(s);
    setStatus(await posApi.tech.status().catch(() => null));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      posApi.tech.getSession().then(s => { if (!s) onExit(); });   // auto-leave on expiry
    }, 1000 * 30);
    return () => clearInterval(t);
  }, []);

  const exit = async () => { await posApi.tech.closeSession(); onExit(); };

  const runDiag = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setMsg('');
    try { await fn(); setMsg(`${label} ✓`); }
    catch (e: any) { setMsg(`${label} failed: ${e?.message ?? 'error'}`); }
    finally { setBusy(''); }
  };

  const testPrinters = () => runDiag('Printer scan', async () => {
    const list = await posApi.print.list();
    await posApi.tech.logAction('tech.printer.scan', { count: list.length });
    setMsg(`Found ${list.length} printer(s)`);
  });

  const forceSync = () => runDiag('Sync', async () => {
    await posApi.sync.trigger();
    await posApi.tech.logAction('tech.sync.trigger');
    setStatus(await posApi.tech.status().catch(() => null));
  });

  const retryFailed = () => runDiag('Retry failed', async () => {
    await posApi.sync.retryFailed();
    await posApi.tech.logAction('tech.sync.retryFailed');
    setStatus(await posApi.tech.status().catch(() => null));
  });

  const remaining = session ? session.expiresAt - now : 0;
  const dev = status?.device;
  const sync = status?.sync;

  return (
    <div className="min-h-screen bg-[#080c14] text-white px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-5">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-amber-400">Technician mode</h1>
            <p className="text-xs text-gray-500">
              {session?.techName} · session ends in {fmtRemaining(remaining)}
            </p>
          </div>
          <button onClick={exit} className="bg-[#1e293b] hover:bg-[#26344b] text-gray-200 rounded-lg px-4 py-2 text-sm">
            End session
          </button>
        </div>

        {/* Device identity */}
        <section className="bg-[#0d1424] border border-[#1e293b] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Device</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <dt className="text-gray-500">Device ID</dt><dd className="font-mono text-gray-300 truncate">{dev?.device_id ?? '—'}</dd>
            <dt className="text-gray-500">Name</dt><dd className="text-gray-300">{dev?.device_name ?? '—'}</dd>
            <dt className="text-gray-500">Role</dt><dd className="text-gray-300">{dev?.device_role ?? '—'}</dd>
            <dt className="text-gray-500">Branch</dt><dd className="font-mono text-gray-300 truncate">{dev?.branch_id ?? '—'}</dd>
            <dt className="text-gray-500">Mode</dt><dd className="text-gray-300">{dev?.deploy_mode ?? '—'}</dd>
            <dt className="text-gray-500">Server</dt><dd className="font-mono text-gray-300 truncate">{dev?.server_url ?? '—'}</dd>
            {dev?.node_url && (<><dt className="text-gray-500">Branch server</dt><dd className="font-mono text-gray-300 truncate">{dev.node_url}</dd></>)}
          </dl>
        </section>

        {/* Sync health */}
        <section className="bg-[#0d1424] border border-[#1e293b] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Sync</h2>
          <div className="grid grid-cols-3 gap-3 text-center mb-4">
            <div className="bg-[#0a0f1a] rounded-lg py-3">
              <div className="text-lg font-bold text-white">{sync?.pending ?? '—'}</div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">Pending</div>
            </div>
            <div className="bg-[#0a0f1a] rounded-lg py-3">
              <div className={`text-lg font-bold ${(sync?.failed ?? 0) > 0 ? 'text-red-400' : 'text-white'}`}>{sync?.failed ?? '—'}</div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">Failed</div>
            </div>
            <div className="bg-[#0a0f1a] rounded-lg py-3">
              <div className={`text-lg font-bold ${sync?.online ? 'text-green-400' : 'text-gray-500'}`}>{sync?.online ? 'On' : 'Off'}</div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">Online</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={forceSync} disabled={!!busy} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm">Force sync</button>
            <button onClick={retryFailed} disabled={!!busy} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm">Retry failed</button>
          </div>
        </section>

        {/* Diagnostics */}
        <section className="bg-[#0d1424] border border-[#1e293b] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Diagnostics</h2>
          <div className="flex gap-2">
            <button onClick={testPrinters} disabled={!!busy} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm">Scan printers</button>
          </div>
          {/* Mode switch (offline<->web) lands in step 5 — placeholder so the slot is visible. */}
          <p className="text-[11px] text-gray-600 mt-3">Mode switch (offline ↔ web) arrives with the sync bridge.</p>
        </section>

        {(busy || msg) && (
          <p className="text-xs text-center text-gray-400">{busy ? `${busy}…` : msg}</p>
        )}

        <p className="text-center text-gray-700 text-[11px]">
          All actions in this session are recorded against {session?.techName} for this branch.
        </p>
      </div>
    </div>
  );
}
