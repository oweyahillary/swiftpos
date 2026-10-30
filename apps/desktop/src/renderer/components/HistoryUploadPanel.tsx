import { useEffect, useState } from 'react';
import { posApi, type HistoryUploadStatus } from '../lib/posApi';
import { historyUploadLine } from '../lib/syncNotice';

// A602 — going online later. Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 6): new sales first; the older
// sales as a bulk upload in quiet hours, back as far as the owner chooses. Shown under Manager › Settings › Backup and on
// the Tech page; main/historyUpload.ts does the work and checks who may change it (the Backup panel's people).

const WINDOWS: { key: HistoryUploadStatus['window']; label: string }[] = [
  { key: '3m', label: 'The last 3 months' }, { key: '12m', label: 'The last 12 months' }, { key: 'all', label: 'Everything' },
];
const when = (iso: string | null) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
};

export default function HistoryUploadPanel() {
  const [st, setSt] = useState<HistoryUploadStatus | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => posApi.historyUpload.status()
    .then((s) => { setSt(s); setErr(''); setFrom((f) => f || s.quietFrom); setTo((t) => t || s.quietTo); })
    .catch((e) => setErr(e?.message ?? 'Could not read the history upload.'));
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);

  const save = async (patch: { window?: HistoryUploadStatus['window']; quietFrom?: string; quietTo?: string }) => {
    setBusy(true); setMsg('');
    try { const s = await posApi.historyUpload.setSettings(patch); setSt(s); setMsg('Saved.'); }
    catch (e: any) { setMsg(e?.message ?? 'Not saved.'); }
    finally { setBusy(false); }
  };

  if (err) return <p className="text-sm text-red-400" data-testid="history-error">{err}</p>;
  if (!st) return null;
  const line = historyUploadLine(st);

  return (
    <section className="max-w-xl border border-gray-800 rounded-xl p-4 space-y-3 mt-6" data-testid="history-upload">
      <div>
        <p className="text-white text-sm font-medium">Sales history on the cloud</p>
        <p className="text-xs text-gray-400 mt-1">
          When this POS starts backing up to the ZapTill cloud again, new sales go first. Older sales go up in quiet hours,
          or when the POS has not been used for 10 minutes, and stop the moment a sale starts.
        </p>
      </div>
      {line && <p className="text-sm text-gray-200" data-testid="history-progress">{line}</p>}
      {!st.active && st.finishedAt && <p className="text-xs text-gray-400">History upload finished {when(st.finishedAt)}.</p>}
      {st.localOnly > 0 && (
        <p className="text-xs text-gray-400" data-testid="history-local-only">
          {st.localOnly.toLocaleString('en-US')} older sale{st.localOnly === 1 ? ' stays' : 's stay'} on this PC only (and in its backups).
        </p>
      )}
      {st.active && st.lastResult && <p className="text-xs text-gray-500">Last upload {when(st.lastBatchAt)}: {st.lastResult}</p>}

      <div className="space-y-1">
        <p className="text-xs text-gray-300">How far back to send</p>
        <div className="flex flex-wrap gap-2">
          {WINDOWS.map((w) => (
            <button key={w.key} onClick={() => save({ window: w.key })} disabled={busy || st.window === w.key} data-testid={`history-window-${w.key}`}
              className={`px-3 py-1.5 rounded-lg text-sm ${st.window === w.key ? 'bg-action-500 text-white' : 'bg-gray-800 text-gray-200'} disabled:opacity-60`}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-xs text-gray-300">Quiet hours</p>
        <div className="flex items-center gap-2">
          <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="history-quiet-from"
            className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-sm text-white" />
          <span className="text-gray-400 text-sm">to</span>
          <input type="time" value={to} onChange={(e) => setTo(e.target.value)} data-testid="history-quiet-to"
            className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-sm text-white" />
          <button onClick={() => save({ quietFrom: from, quietTo: to })} disabled={busy || (from === st.quietFrom && to === st.quietTo)}
            className="px-3 py-1.5 rounded-lg bg-gray-800 text-white text-sm disabled:opacity-40">Save</button>
        </div>
      </div>
      {msg && <p className="text-xs text-gray-300" data-testid="history-msg">{msg}</p>}
    </section>
  );
}
