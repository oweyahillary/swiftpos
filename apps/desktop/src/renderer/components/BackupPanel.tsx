import { useEffect, useState } from 'react';
import { posApi, type BackupStatus, type BackupCheck } from '../lib/posApi';

// A600 — Manager › Settings › Backup. Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 5): every PC backs
// itself up, and the owner or a manager can see it and act on it without a technician. Restore is the owner's (or a
// technician's) and needs the word RESTORE typed. main/backupService.ts checks every right again.

const when = (iso: string | null) => {
  if (!iso) return 'never';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
};
// A600 follow-up: why the last copy was made, in the panel's words.
const REASON: Record<string, string> = { day_close: 'after the day was closed', shift_close: 'after a shift was closed', manual: 'Back up now', folder: 'when the folder was chosen' };
const size = (b: number | null | undefined) => (b == null ? '' : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export default function BackupPanel() {
  const [st, setSt] = useState<BackupStatus | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<'' | 'now' | 'dir' | 'pick' | 'restore'>('');
  const [check, setCheck] = useState<BackupCheck | null>(null);
  const [typed, setTyped] = useState('');

  const load = () => posApi.backup.status().then((s) => { setSt(s); setErr(''); }).catch((e) => setErr(e?.message ?? 'Could not read the backups.'));
  useEffect(() => { load(); }, []);

  const backUpNow = async () => {
    setBusy('now'); setMsg('');
    try {
      const r = await posApi.backup.now();
      setMsg(r.ok ? 'Backed up just now.' : `The backup failed: ${r.error ?? 'unknown error'}`);
    } catch (e: any) { setMsg(e?.message ?? 'The backup failed.'); }
    finally { setBusy(''); load(); }
  };

  const changeDir = async (useDefault: boolean) => {
    setMsg('');
    const dir = useDefault ? null : await posApi.backup.chooseDir().catch(() => null);
    if (!useDefault && !dir) return;   // cancelled
    setBusy('dir');
    try {
      const r = await posApi.backup.setDir(dir);
      setMsg(r.ok ? `Backups now go to ${r.dir}. One was saved there just now.` : (r.error ?? 'That folder could not be used.'));
    } catch (e: any) { setMsg(e?.message ?? 'That folder could not be used.'); }
    finally { setBusy(''); load(); }
  };

  const pickRestore = async () => {
    setBusy('pick'); setCheck(null); setTyped(''); setMsg('');
    try { setCheck(await posApi.backup.chooseRestoreFile()); }
    catch (e: any) { setMsg(e?.message ?? 'The file could not be checked.'); }
    finally { setBusy(''); }
  };

  const restore = async () => {
    if (!check?.token) return;
    setBusy('restore'); setMsg('');
    try {
      const r = await posApi.backup.restore(check.token, typed);
      if (r.ok) setMsg('Restoring — ZapTill restarts now. A safety copy of the data from before is kept.');
      else { setMsg(r.error ?? 'The backup was not restored.'); setBusy(''); }
    } catch (e: any) { setMsg(e?.message ?? 'The backup was not restored.'); setBusy(''); }
  };

  if (err) return <p className="text-sm text-red-400" data-testid="backup-error">{err}</p>;
  if (!st) return <p className="text-sm text-gray-400">Loading…</p>;

  return (
    <div className="max-w-xl space-y-6" data-testid="backup-panel">
      <div>
        <h2 className="text-lg font-semibold text-white">Backup</h2>
        <p className="text-sm text-gray-400 mt-1">
          Backed up every 6 hours and after the day is closed; the {st.keep} most recent copies are kept.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          At 3 am, 9 am, 3 pm and 9 pm, or soon after this PC is switched on if it was off then. Older copies are deleted.
        </p>
      </div>

      {st.warn && (
        <div className="border border-red-500 bg-red-500/10 rounded-xl p-4" data-testid="backup-warning">
          <p className="text-sm font-semibold text-red-300">
            {!st.last_backup_at ? 'No backup yet' : (st.hours_since ?? 0) >= 48 ? 'No backup in the last 2 days' : 'No backup in the last 12 hours'}
          </p>
          <p className="text-xs text-red-200 mt-1">If this PC breaks, sales since the last backup could be lost. Press Back up now.</p>
        </div>
      )}

      {st.space_short && (
        <div className="border border-red-500 bg-red-500/10 rounded-xl p-4" data-testid="backup-space-warning">
          <p className="text-sm font-semibold text-red-300">{st.space_short.message}</p>
          <p className="text-xs text-red-200 mt-1">
            {size(st.space_short.free)} free, {size(st.space_short.need)} needed. The backup runs by itself once there is room.
          </p>
        </div>
      )}

      <section className="border border-gray-800 rounded-xl p-4 space-y-2">
        <p className="text-white text-sm font-medium">Last backup</p>
        <p className="text-sm text-gray-300" data-testid="backup-last">
          {when(st.last_backup_at)}{st.last_backup_bytes ? ` · ${size(st.last_backup_bytes)}` : ''}
          {st.last_backup_reason && REASON[st.last_backup_reason] ? ` · ${REASON[st.last_backup_reason]}` : ''}
        </p>
        {st.last_backup_path && <p className="text-xs text-gray-500 break-all">{st.last_backup_path}</p>}
        {st.failed && <p className="text-xs text-red-400" data-testid="backup-failed">The last try failed: {st.last_backup_status?.replace(/^FAILED — /, '')}</p>}
        <button onClick={backUpNow} disabled={!!busy || st.running} data-testid="backup-now"
          className="mt-2 px-4 py-2 rounded-lg bg-action-500 text-white text-sm font-medium disabled:opacity-40">
          {busy === 'now' || st.running ? 'Backing up…' : 'Back up now'}
        </button>
      </section>

      <section className="border border-gray-800 rounded-xl p-4 space-y-2">
        <p className="text-white text-sm font-medium">Where the copies go</p>
        <p className="text-sm text-gray-300 break-all" data-testid="backup-dir">{st.dir}</p>
        <p className="text-xs text-gray-500" data-testid="backup-copies">
          {st.copies} cop{st.copies === 1 ? 'y' : 'ies'} there now{st.copies_bytes ? `, using ${size(st.copies_bytes)}` : ''}.
        </p>
        <p className={`text-xs ${st.same_disk ? 'text-amber-300' : 'text-gray-400'}`} data-testid="backup-disk-note">
          Copies on this PC&apos;s own disk are lost if that disk fails. A USB stick or a second disk is safer.
        </p>
        <div className="flex gap-2 pt-1">
          <button onClick={() => changeDir(false)} disabled={!!busy} data-testid="backup-choose-dir"
            className="px-4 py-2 rounded-lg bg-gray-800 text-white text-sm disabled:opacity-40">
            {busy === 'dir' ? 'Saving a copy there…' : 'Choose folder…'}
          </button>
          {st.custom_dir && (
            <button onClick={() => changeDir(true)} disabled={!!busy}
              className="px-4 py-2 rounded-lg bg-gray-800 text-gray-300 text-sm disabled:opacity-40">Use the default folder</button>
          )}
        </div>
      </section>

      {msg && <p className="text-sm text-gray-200" data-testid="backup-msg">{msg}</p>}

      {st.can_restore && (
        <section className="border border-gray-800 rounded-xl p-4 space-y-3" data-testid="backup-restore">
          <div>
            <p className="text-white text-sm font-medium">Restore from a backup</p>
            <p className="text-xs text-gray-400 mt-1">
              Puts a backup back in place of this POS&apos;s data, then restarts ZapTill. Only backups of this business can be restored.
            </p>
          </div>
          <button onClick={pickRestore} disabled={!!busy} data-testid="backup-pick"
            className="px-4 py-2 rounded-lg bg-gray-800 text-white text-sm disabled:opacity-40">
            {busy === 'pick' ? 'Checking the file…' : 'Choose a backup file…'}
          </button>

          {check && !check.ok && (
            <p className="text-sm text-red-400" data-testid="backup-refused">{check.refusal}</p>
          )}
          {check && check.ok && check.backup && (
            <div className="space-y-2">
              <p className="text-sm text-gray-200">
                Backup made {when(check.backup.taken_at)} · {size(check.backup.bytes)}
                {check.backup.business_name ? ` · ${check.backup.business_name}` : ''}
                {check.backup.pos_name ? ` · ${check.backup.pos_name}` : ''}
              </p>
              <p className="text-xs text-gray-400">{check.backup.orders} sale{check.backup.orders === 1 ? '' : 's'} in it, the last {when(check.backup.last_sale_at)}.</p>
              {check.warnings.map((w) => <p key={w} className="text-xs text-amber-300">{w}</p>)}
              <label className="block text-xs text-gray-300">
                Type RESTORE to confirm
                <input value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="backup-confirm"
                  className="mt-1 block w-48 px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white text-sm" />
              </label>
              <button onClick={restore} disabled={!!busy || typed.trim().toUpperCase() !== 'RESTORE'} data-testid="backup-restore-go"
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium disabled:opacity-40">
                {busy === 'restore' ? 'Restoring…' : 'Restore and restart'}
              </button>
            </div>
          )}
          {st.last_restore && (
            <p className="text-xs text-gray-500">
              Last restore: {when(st.last_restore.at)}{st.last_restore.applied ? '' : ` (did not happen: ${st.last_restore.error})`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
