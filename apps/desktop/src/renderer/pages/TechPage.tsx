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

  // Read-only DB console
  const [querySql, setQuerySql] = useState('');
  const [queryErr, setQueryErr] = useState('');
  const [queryRes, setQueryRes] = useState<null | {
    columns: string[]; rows: unknown[][]; rowCount: number;
    truncated: boolean; maskedColumns: string[];
  }>(null);
  const [maint, setMaint] = useState<null | { last_backup_at: string | null; last_backup_status: string | null;
    backup_dir: string; last_prune_at: string | null; retention_days: number }>(null);
  const [backupMsg, setBackupMsg] = useState('');
  useEffect(() => { posApi.tech.maintenance().then(setMaint).catch(() => {}); }, []);
  const [nodeAddr, setNodeAddr] = useState('');
  const [roleMsg, setRoleMsg] = useState('');
  const promote = async () => {
    setBusy('promote'); setRoleMsg('');
    try {
      const r = await posApi.tech.promoteToNode();
      setRoleMsg(r.ok ? `Promoted. Branch access code: ${r.secret} — ${r.note}` : (r.error ?? 'failed'));
      load();
    } finally { setBusy(''); }
  };
  const repoint = async () => {
    setBusy('repoint'); setRoleMsg('');
    try {
      const r = await posApi.tech.setNodeUrl(nodeAddr.trim());
      setRoleMsg(r.ok ? `Saved — this machine is now a ${r.role} pointing at ${nodeAddr.trim()}.` : (r.error ?? 'failed'));
      load();
    } finally { setBusy(''); }
  };

  const runBackup = async () => {
    setBusy('backup'); setBackupMsg('');
    try {
      const r = await posApi.tech.backupNow();
      setBackupMsg(r.ok ? `Done — ${r.path}` : (r.error ?? 'failed'));
      posApi.tech.maintenance().then(setMaint).catch(() => {});
    } finally { setBusy(''); }
  };

  const runQuery = async () => {
    setBusy('query'); setQueryErr(''); setQueryRes(null);
    try {
      const r = await posApi.tech.query(querySql);
      if (r.ok === true) setQueryRes(r.result);
      else setQueryErr((r as { ok: false; error: string }).error);
    } catch (e: any) {
      setQueryErr(e?.message ?? 'Query failed');
    } finally { setBusy(''); }
  };

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

        {/* Branch role (Phase 3) */}
        <section className="bg-[#0d1424] border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-1">Branch role</h2>
          <p className="text-xs text-gray-400 mb-3">
            This machine: <span className="text-gray-200 font-medium">{dev?.device_role ?? '—'}</span>
          </p>
          {dev?.device_role === 'till' && (
            <>
              <button onClick={promote} disabled={busy === 'promote'}
                className="w-full bg-amber-700/80 hover:bg-amber-600 disabled:opacity-40 text-white rounded-lg py-2 text-sm">
                {busy === 'promote' ? 'Promoting…' : 'Promote to branch server'}
              </button>
              <p className="text-[11px] text-gray-500 mt-1.5">
                Use when the branch server has failed. This till already holds the branch data;
                afterwards, point each remaining till here (below, on those tills).
              </p>
            </>
          )}
          <div className="mt-3">
            <label className="block text-[11px] text-gray-400 mb-1">Branch server address (this till points at)</label>
            <div className="flex gap-2">
              <input value={nodeAddr} onChange={e => setNodeAddr(e.target.value)}
                placeholder="http://192.168.1.20:4100" spellCheck={false}
                className="flex-1 bg-[#0a0f1c] border border-gray-700 rounded-lg px-2 py-1.5 text-xs font-mono text-gray-200" />
              <button onClick={repoint} disabled={busy === 'repoint' || !nodeAddr.trim()}
                className="bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg px-3 text-xs whitespace-nowrap">
                {busy === 'repoint' ? 'Testing…' : 'Test & save'}
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">Tested before saving — a wrong address written blind is a till that silently stops replicating. On a former server this also steps it down to a till.</p>
          </div>
          {roleMsg && <p className={`text-xs mt-2 ${/fail|refused|No branch/i.test(roleMsg) ? 'text-red-400' : 'text-green-400'}`}>{roleMsg}</p>}
        </section>

        {/* Backups & retention (Phase 2c) */}
        <section className="bg-[#0d1424] border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-1">Backups &amp; retention</h2>
          {maint ? (
            <div className="text-xs text-gray-400 space-y-1">
              <p>Last backup: <span className={/FAILED/.test(maint.last_backup_status ?? '') ? 'text-red-400' : 'text-gray-200'}>
                {maint.last_backup_at ? new Date(maint.last_backup_at).toLocaleString() : 'never'}</span>
                {maint.last_backup_status && <span> — {maint.last_backup_status}</span>}</p>
              <p>Backup folder: <span className="text-gray-300 font-mono">{maint.backup_dir}</span></p>
              <p>Replica retention: <span className="text-gray-300">{maint.retention_days} days</span>
                {maint.last_prune_at && <span> · last prune {new Date(maint.last_prune_at).toLocaleDateString()}</span>}</p>
            </div>
          ) : <p className="text-xs text-gray-500">Loading…</p>}
          <button
            onClick={runBackup} disabled={busy === 'backup'}
            className="mt-3 w-full bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm">
            {busy === 'backup' ? 'Backing up…' : 'Back up now'}
          </button>
          {backupMsg && <p className={`text-xs mt-2 ${/FAILED|failed/.test(backupMsg) ? 'text-red-400' : 'text-green-400'}`}>{backupMsg}</p>}
        </section>

        {/* Read-only database console */}
        <section className="bg-[#0d1424] border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-1">Database (read-only)</h2>
          <p className="text-[11px] text-gray-400 mb-3">
            SELECT only, one statement, 500 rows. Columns holding secrets (PINs, tokens, keys)
            are masked. Every query is written to the tech audit verbatim.
          </p>
          <textarea
            value={querySql}
            onChange={e => setQuerySql(e.target.value)}
            placeholder="SELECT id, status, sync_status FROM shifts ORDER BY opened_at DESC LIMIT 20"
            spellCheck={false}
            className="w-full bg-[#0a0f1c] border border-gray-700 rounded-lg p-2 text-xs font-mono text-gray-200 h-20 resize-y"
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={runQuery} disabled={!!busy || !querySql.trim()}
              className="flex-1 bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm">
              Run query
            </button>
          </div>
          {queryErr && <p className="text-xs text-red-400 mt-2">{queryErr}</p>}
          {queryRes && (
            <div className="mt-3">
              <p className="text-[11px] text-gray-400 mb-1">
                {queryRes.rowCount} row{queryRes.rowCount === 1 ? '' : 's'}
                {queryRes.truncated ? ' (showing first 500)' : ''}
                {queryRes.maskedColumns.length > 0 && (
                  <span className="text-amber-400"> · masked: {queryRes.maskedColumns.join(', ')}</span>
                )}
              </p>
              <div className="overflow-auto max-h-72 border border-gray-800 rounded-lg">
                <table className="text-[11px] font-mono w-full">
                  <thead className="bg-[#0a0f1c] sticky top-0">
                    <tr>{queryRes.columns.map(c => (
                      <th key={c} className="text-left text-gray-400 px-2 py-1 whitespace-nowrap">{c}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {queryRes.rows.map((r, i) => (
                      <tr key={i} className="odd:bg-[#0d1424] even:bg-[#0a0f1c]">
                        {r.map((v, j) => (
                          <td key={j} className="px-2 py-1 text-gray-200 whitespace-nowrap">
                            {v === null ? <span className="text-gray-500">null</span> : String(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
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
