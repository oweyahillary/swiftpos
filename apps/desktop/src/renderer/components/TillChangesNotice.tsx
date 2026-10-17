/**
 * TillChangesNotice — A448: on the manager screens, the changes made on this till that have not settled with the cloud
 * yet: waiting to be sent (offline, or the cloud not reached yet), with the owner (someone else changed the same thing
 * differently — "notify the owner requesting approval"), or refused (with the reason). Nothing shows when all is settled.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

type Row = Awaited<ReturnType<typeof posApi.manage.changeStates>>[number];

export default function TillChangesNotice() {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const load = () => { posApi.manage.changeStates().then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => {}); };
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  if (!rows.length) return null;
  const pending = rows.filter((r) => r.state === 'pending').length;
  const awaiting = rows.filter((r) => r.state === 'awaiting').length;
  const refused = rows.filter((r) => r.state === 'refused').length;
  const parts = [
    pending ? `${pending} saved on this till, not on the cloud yet` : '',
    awaiting ? `${awaiting} waiting for the owner's approval` : '',
    refused ? `${refused} not taken by the cloud` : '',
  ].filter(Boolean);
  return (
    <div data-testid="till-changes-notice" className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between gap-3 text-left">
        <span className="text-amber-200">Changes made on this till: {parts.join(' · ')}</span>
        <span className="text-xs text-gray-300">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-xs">
          {rows.map((r, i) => (
            <li key={i} className="flex justify-between gap-3 text-gray-200">
              <span>{r.summary}</span>
              <span className={r.state === 'refused' ? 'text-red-300' : 'text-gray-400'}>
                {r.state === 'pending' ? 'not on the cloud yet' : r.state === 'awaiting' ? 'with the owner' : `refused: ${r.message ?? ''}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* A520: a refused change is already undone on this till (the cloud's value came back with the pull) — said, and
          cleared from here once read. Make it again on the web if it is still wanted. */}
      {open && refused > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs" data-testid="till-changes-refused">
          <span className="text-gray-300">Refused changes are not on this till — the cloud's value stands. Make the change again on the web if it is still wanted.</span>
          <button data-testid="till-changes-clear" onClick={() => {
            posApi.manage.dismissRefusedChanges().then(() => posApi.manage.changeStates())
              .then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => {});
          }} className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700/40">Clear refused</button>
        </div>
      )}
    </div>
  );
}
