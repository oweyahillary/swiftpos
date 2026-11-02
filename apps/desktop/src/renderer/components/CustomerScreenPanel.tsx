import { useEffect, useState } from 'react';
import { posApi, type CustomerDisplayStatus } from '../lib/posApi';

// A606 — the customer screen (a dual-screen POS's second monitor). Off, or On on a chosen screen; remembered on this PC.
// Shown on the Tech page and under Manager › Settings; main/customerDisplay.ts does the work and checks who may change it
// (a technician, or someone who manages the business settings). A chosen screen that is not connected leaves it off
// quietly — the note below says so.
// A607 — "The customer screen is a touch screen" (this PC): the customer may then type their details (and their M-Pesa
// number) on it when the cashier asks — premium, with the online licence (main/ipc/customerDetails.ts).

export default function CustomerScreenPanel({ className = '' }: { className?: string }) {
  const [st, setSt] = useState<CustomerDisplayStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [touch, setTouch] = useState<{ touch: boolean; licensed: boolean } | null>(null);   // A607

  const load = () => {
    posApi.customerDisplay.askable().then((a) => setTouch({ touch: a.touch, licensed: a.licensed })).catch(() => {});
    return posApi.customerDisplay.status().then(setSt).catch(() => setSt(null));
  };
  useEffect(() => { void load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, []);

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true); setMsg('');
    try { const r = await what(); if (r && typeof r === 'object' && 'choice' in (r as any)) setSt(r as CustomerDisplayStatus); setMsg(done); }
    catch (e: any) { setMsg(String(e?.message ?? 'Not done.').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); void load(); }
  };

  if (!st) return null;
  const others = st.screens.filter((s) => !s.primary);
  const value = st.choice.enabled && st.choice.displayId !== null ? String(st.choice.displayId) : 'off';
  const choose = (v: string) => run(() => posApi.customerDisplay.set(v === 'off' ? { enabled: false, displayId: null } : { enabled: true, displayId: Number(v) }),
    v === 'off' ? 'Customer screen off.' : 'Customer screen on.');

  return (
    <section className={`border border-gray-800 rounded-xl p-4 space-y-3 ${className}`} data-testid="customer-screen-panel">
      <div>
        <p className="text-white text-sm font-medium">Customer screen</p>
        <p className="text-xs text-gray-400 mt-1">
          On a POS with a second screen facing the customer: the items and prices as they are rung up, the total, the
          payment and the change. Saved on this PC. {st.screens.length} screen{st.screens.length === 1 ? '' : 's'} connected.
        </p>
      </div>
      <label className="flex items-center gap-3 text-sm text-gray-200">
        <span>Customer screen</span>
        <select value={value} disabled={busy} onChange={(e) => void choose(e.target.value)} data-testid="customer-screen-choice"
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white">
          <option value="off">Off</option>
          {others.map((s) => <option key={s.id} value={String(s.id)}>On (display {s.n}, {s.width}×{s.height})</option>)}
          {st.choice.enabled && st.choice.displayId !== null && !others.some((s) => s.id === st.choice.displayId) &&
            <option value={String(st.choice.displayId)}>On (screen not connected)</option>}
        </select>
      </label>
      {touch && (
        <label className="flex items-start gap-2 text-sm text-gray-200">
          <input type="checkbox" className="mt-0.5" checked={touch.touch} disabled={busy} data-testid="customer-screen-touch"
            onChange={(e) => { const on = e.target.checked; void run(() => posApi.customerDisplay.setTouch(on), on ? 'The customer can type their details on the customer screen.' : 'The customer screen is not a touch screen.'); }} />
          <span>The customer screen is a touch screen
            <span className="block text-xs text-gray-400">The customer types their phone, name and KRA PIN on it when the cashier asks.
              {!touch.licensed && ' Part of the online licence — ask ZapTill to turn it on.'}</span></span>
        </label>
      )}
      {st.note && <p className="text-xs text-amber-300" data-testid="customer-screen-note">{st.note}</p>}
      {!st.note && st.open && st.on !== null && <p className="text-xs text-gray-400">Showing on display {st.on}.</p>}
      <div className="flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => void run(() => posApi.customerDisplay.identify(), 'Each screen shows its number for a few seconds.')}
          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm" data-testid="customer-screen-identify">Identify displays</button>
        <button disabled={busy || others.length === 0} onClick={() => void run(() => posApi.customerDisplay.test(), 'A sample sale shows on the customer screen for a few seconds.')}
          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm disabled:opacity-50" data-testid="customer-screen-test">Show test screen</button>
      </div>
      {msg && <p className="text-xs text-gray-300">{msg}</p>}
    </section>
  );
}
