/**
 * UpdateDiagnosticsPanel — A496: on the Tech page of every machine, why this machine has (or has not) got its update.
 *
 * Owner, 2026-10-15: "check update function on server till setup sometimes the tills never gets updates". The update
 * loop now logs every decision as one plain sentence (asked the server, waiting because…, downloading from…, stalled and
 * cancelled); this shows the reason and the last of those lines, so a tech can see it at the till instead of in a log file.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

type Diag = Awaited<ReturnType<typeof posApi.update.getDiagnostics>>;

const clock = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleTimeString(); };

export default function UpdateDiagnosticsPanel() {
  const [diag, setDiag] = useState<Diag | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const load = () => { posApi.update.getDiagnostics().then(setDiag).catch(() => {}); };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!diag) return null;
  const s = diag.status;
  return (
    <div data-testid="update-diagnostics" className="text-xs space-y-1.5">
      <p className="text-gray-300">
        {s.note || (s.version ? `${s.state} v${s.version}` : 'Up to date.')}
      </p>
      <p className="text-gray-500">
        {s.approved ? `Approved for this business: v${s.approved}. ` : ''}
        {s.checkedAt ? `Last checked ${clock(s.checkedAt)}.` : 'Not checked yet.'}
      </p>
      {/* A508: the idle install — here on the Tech page only (no banner for the cashier). */}
      {diag.idleNote && <p data-testid="update-idle-note" className="text-gray-500">Installing on its own: {diag.idleNote}.</p>}
      {diag.idleInstall && (
        <p data-testid="update-idle-install" className={diag.idleInstall.ok ? 'text-gray-400' : 'text-amber-400'}>
          {diag.idleInstall.ok
            ? `Updated from v${diag.idleInstall.from} to v${diag.idleInstall.to} while idle, ${new Date(diag.idleInstall.at).toLocaleString()}.`
            : `An install of v${diag.idleInstall.to} while idle (${new Date(diag.idleInstall.at).toLocaleString()}) did not take — it installs when ZapTill is closed.`}
        </p>
      )}
      {/* A509: the updater task — whether updates can install with no Windows prompt on this machine. */}
      {diag.updaterTask && diag.updaterTask.installed !== null && (
        <p data-testid="update-task" className="text-gray-500">
          {diag.updaterTask.installed
            ? 'Updater task: installed — updates install without a Windows prompt.'
            : 'Updater task: not installed — updates install when ZapTill is closed, and Windows asks for permission. Reinstalling ZapTill adds it.'}
        </p>
      )}
      {/* A513: how the last start went (Tech page only — never a cashier banner), and the low-memory graphics mode. */}
      {diag.startup && <p data-testid="startup-line" className="text-gray-500">Last start — {diag.startup}.</p>}
      {diag.graphics && <p data-testid="graphics-line" className="text-gray-500">{diag.graphics.replace(/^graphics: /, 'Graphics: ')}.</p>}
      {(diag.log.length > 0 || (diag.updaterTask?.log.length ?? 0) > 0) && (
        <>
          <button onClick={() => setOpen((o) => !o)} className="text-gray-400 hover:text-gray-200 underline">
            {open ? 'Hide update log' : 'Show update log'}
          </button>
          {open && (
            <ul className="bg-[#0a0f1c] border border-gray-800 rounded-lg p-2 max-h-48 overflow-y-auto font-mono text-[11px] text-gray-400 space-y-0.5">
              {diag.log.map((l, i) => <li key={i}><span className="text-gray-600">{clock(l.at)}</span> {l.line}</li>)}
            </ul>
          )}
          {open && (diag.updaterTask?.log.length ?? 0) > 0 && (
            <ul data-testid="update-task-log" className="bg-[#0a0f1c] border border-gray-800 rounded-lg p-2 max-h-32 overflow-y-auto font-mono text-[11px] text-gray-500 space-y-0.5">
              {diag.updaterTask!.log.map((l, i) => <li key={i}>updater: {l}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
