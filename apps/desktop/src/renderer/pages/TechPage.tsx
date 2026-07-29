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

  // Device reset. Two stages on purpose: nothing is offered until we know what
  // would be destroyed, and the destructive button is only reachable after the
  // technician has been shown the number.
  const [resetInfo, setResetInfo] = useState<null | {
    terminalCode: string | null; deviceRole: string | null;
    unsyncedOrders: number; unsyncedValue: number; openShifts: number; safe: boolean;
  }>(null);
  const [resetTyped, setResetTyped] = useState('');

  const previewReset = async () => {
    setBusy('Checking');
    try { setResetInfo(await posApi.config.resetPreview()); }
    catch (e: any) { setMsg(e?.message ?? 'Could not check this device.'); }
    finally { setBusy(''); }
  };

  const doReset = async () => {
    setBusy('Resetting');
    try {
      await posApi.tech.logAction('tech.device.reset', {
        terminal: resetInfo?.terminalCode, unsynced: resetInfo?.unsyncedOrders,
      });
      await posApi.config.reset(false);   // never force — the guard is the point
    } catch (e: any) {
      setMsg(e?.message ?? 'Reset failed.');
      setBusy('');
    }
  };

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
            <p className="text-xs text-gray-300">
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
            <dt className="text-gray-300">Device ID</dt><dd className="font-mono text-gray-300 truncate">{dev?.device_id ?? '—'}</dd>
            <dt className="text-gray-300">Name</dt><dd className="text-gray-300">{dev?.device_name ?? '—'}</dd>
            <dt className="text-gray-300">Role</dt><dd className="text-gray-300">{dev?.device_role ?? '—'}</dd>
            <dt className="text-gray-300">Branch</dt><dd className="font-mono text-gray-300 truncate">{dev?.branch_id ?? '—'}</dd>
            <dt className="text-gray-300">Mode</dt><dd className="text-gray-300">{dev?.deploy_mode ?? '—'}</dd>
            <dt className="text-gray-300">Server</dt><dd className="font-mono text-gray-300 truncate">{dev?.server_url ?? '—'}</dd>
            {dev?.node_url && (<><dt className="text-gray-300">Branch server</dt><dd className="font-mono text-gray-300 truncate">{dev.node_url}</dd></>)}
          </dl>
        </section>

        {/* Sync health */}
        <section className="bg-[#0d1424] border border-[#1e293b] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Sync</h2>
          <div className="grid grid-cols-3 gap-3 text-center mb-4">
            <div className="bg-[#0a0f1a] rounded-lg py-3">
              <div className="text-lg font-bold text-white">{sync?.pending ?? '—'}</div>
              <div className="text-[10px] text-gray-300 uppercase tracking-wide">Pending</div>
            </div>
            <div className="bg-[#0a0f1a] rounded-lg py-3">
              <div className={`text-lg font-bold ${(sync?.failed ?? 0) > 0 ? 'text-red-400' : 'text-white'}`}>{sync?.failed ?? '—'}</div>
              <div className="text-[10px] text-gray-300 uppercase tracking-wide">Failed</div>
            </div>
            <div className="bg-[#0a0f1a] rounded-lg py-3">
              <div className={`text-lg font-bold ${sync?.online ? 'text-green-400' : 'text-gray-300'}`}>{sync?.online ? 'On' : 'Off'}</div>
              <div className="text-[10px] text-gray-300 uppercase tracking-wide">Online</div>
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
          <p className="text-[11px] text-gray-400 mt-3">Mode switch (offline ↔ web) arrives with the sync bridge.</p>
        </section>

        {/* Reset this device */}
        <section className="bg-[#0d1424] border border-red-900/40 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-1">Reset this device</h2>
          <p className="text-[11px] text-gray-400 mb-3">
            Clears the terminal code, printer settings and all local data, then restarts into setup.
            The catalogue comes back on the next sync. Sales already on the server are not affected.
          </p>

          {!resetInfo ? (
            <button onClick={previewReset} disabled={!!busy}
              className="w-full bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm">
              Check what this would delete
            </button>
          ) : (
            <div className="space-y-3">
              <div className="text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-400">Terminal</span>
                  <span className="text-gray-200 font-mono">{resetInfo.terminalCode ?? '—'} · {resetInfo.deviceRole ?? '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Orders not yet on the server</span>
                  <span className={resetInfo.unsyncedOrders > 0 ? 'text-red-400 font-semibold' : 'text-green-400'}>
                    {resetInfo.unsyncedOrders}
                  </span>
                </div>
                {resetInfo.unsyncedOrders > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Value at risk</span>
                    <span className="text-red-400 font-semibold">
                      {resetInfo.unsyncedValue.toLocaleString('en-KE', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-400">Open shifts</span>
                  <span className={resetInfo.openShifts > 0 ? 'text-amber-400' : 'text-green-400'}>{resetInfo.openShifts}</span>
                </div>
              </div>

              {!resetInfo.safe ? (
                /* Blocked, not warned. A till holding sales the server has never
                   seen must not be wipeable from a button — those takings exist
                   nowhere else, and nobody would discover the loss until the
                   day's totals failed to add up. */
                <div className="border border-red-500/40 bg-red-500/10 rounded-lg p-3">
                  <p className="text-xs text-red-300">
                    {resetInfo.unsyncedOrders > 0
                      ? 'This till is holding sales the server has never seen. Get it online, let them sync, then check again. Resetting now would destroy them and there is no other copy.'
                      : 'A shift is still open. Close it before resetting, or the day cannot be reconciled.'}
                  </p>
                  <button onClick={previewReset} disabled={!!busy}
                    className="w-full mt-2 bg-[#1e293b] hover:bg-[#26344b] text-gray-200 rounded-lg py-1.5 text-xs">
                    Check again
                  </button>
                </div>
              ) : (
                <div className="border border-red-500/40 bg-red-500/5 rounded-lg p-3 space-y-2">
                  <p className="text-xs text-gray-200">
                    Nothing is at risk. Type <span className="font-mono text-red-300">{resetInfo.terminalCode ?? 'RESET'}</span> to confirm.
                  </p>
                  <input value={resetTyped} onChange={e => setResetTyped(e.target.value)}
                    placeholder={resetInfo.terminalCode ?? 'RESET'}
                    className="w-full bg-[#0b1120] border border-[#1e293b] rounded-lg px-3 py-2 text-gray-200 text-sm font-mono" />
                  <div className="flex gap-2">
                    <button onClick={() => { setResetInfo(null); setResetTyped(''); }}
                      className="flex-1 border border-[#1e293b] text-gray-200 rounded-lg py-2 text-xs hover:bg-[#1e293b]">
                      Cancel
                    </button>
                    <button onClick={doReset}
                      disabled={!!busy || resetTyped.trim().toUpperCase() !== (resetInfo.terminalCode ?? 'RESET').toUpperCase()}
                      className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded-lg py-2 text-xs font-semibold">
                      Reset and restart
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {(busy || msg) && (
          <p className="text-xs text-center text-gray-400">{busy ? `${busy}…` : msg}</p>
        )}

        <p className="text-center text-gray-400 text-[11px]">
          All actions in this session are recorded against {session?.techName} for this branch.
        </p>
      </div>
    </div>
  );
}
