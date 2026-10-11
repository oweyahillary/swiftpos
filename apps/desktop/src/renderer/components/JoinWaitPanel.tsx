/**
 * JoinWaitPanel — A436: while a till waits for the branch server to allow it, it tells the technician to go to the
 * server and press Allow there (lib/joinNotice.ts), counting down the minutes the request waits.
 */
import { useEffect, useState } from 'react';
import { joinWaitNotice, JOIN_WAIT_MINUTES, type JoinServer } from '../lib/joinNotice';

export default function JoinWaitPanel({ tillName, srv, askedAt }: { tillName: string; srv: JoinServer; askedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const n = joinWaitNotice(tillName, srv, JOIN_WAIT_MINUTES - (now - askedAt) / 60_000);
  return (
    <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3" data-testid="join-wait">
      <p className="text-sm font-semibold text-amber-200">{n.title}</p>
      <ol className="mt-2 space-y-1.5 text-sm text-gray-200 list-decimal list-inside">
        {n.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <p className="mt-2 text-xs text-gray-400 flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-300 animate-pulse" />{n.footer}
      </p>
    </div>
  );
}
