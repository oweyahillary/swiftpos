/**
 * CountedCloseModal — A462: a manager (or the owner) closes someone else's drawer WITH a count, from the web.
 *
 * Owner, 2026-10-13: "how can a manager confirm and close a shift on web" — force-close was the only way, and it records
 * the drawer uncounted. Here the manager counts each payment method (what the shift expects is beside each, with the
 * difference as typed); the cloud closes it counted under the manager (POST /api/shifts/:id/close — a manager may close
 * another person's drawer, A366), a till holding it closes it too at its next sync (A401 — about 90 s while it is on;
 * A522: the copy said "within 20 s"), and it then waits for a manager's confirmation like any closed shift. Force-close
 * stays for a drawer nobody can count.
 *
 * A522 (owner, 2026-10-17: "nothing may wait on a till that is switched off"): when the drawer's till has not synced
 * recently, a tick is asked first ("T2 last synced 3 h ago — its sales since then are not in this close; it applies this
 * when it next connects"); its late sales are added to the drawer when they arrive (the cloud recomputes). Orders sent to
 * the kitchen and unpaid on a till that is off no longer block the owner / a close-day holder: the refusal lists them and
 * a second tick closes anyway (they stay open on that till).
 */
import { useEffect, useState } from 'react';
import { methodName, methodsToDeclare, readAmounts } from '../lib/shiftConfirm';
import { money } from '../lib/format';
import { tillBehindLine } from '../lib/tillSync';

interface Client { get: <T>(p: string) => Promise<T>; post: <T>(p: string, body?: unknown) => Promise<T> }
interface Props {
  client: Client;
  shift: { id: string; cashier_name: string; terminal_code: string | null; device_id?: string | null; till_last_sync_at?: string | null };
  currency: string;
  onDone: () => void;
  onCancel: () => void;
}

export default function CountedCloseModal({ client, shift, currency, onDone, onCancel }: Props) {
  const [codes, setCodes] = useState<string[]>(['cash']);
  const [expected, setExpected] = useState<Record<string, number>>({});
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // A522: the till has not synced lately — its sales since are not in this close (a tick first).
  const behind = shift.device_id ? tillBehindLine(shift.terminal_code ?? 'The POS', shift.till_last_sync_at ?? null) : null;
  const [behindOk, setBehindOk] = useState(false);
  // A522: unpaid kitchen orders on a till that is off — the cloud lists them; the owner / a close-day holder may go ahead.
  const [unpaid, setUnpaid] = useState<string | null>(null);
  const [unpaidOk, setUnpaidOk] = useState(false);

  useEffect(() => {
    client.get<any>(`/api/shifts/${shift.id}/zreport`).then((z) => {
      const by: Array<{ method: string; amount: number }> = Array.isArray(z?.byMethod) ? z.byMethod : [];
      const exp: Record<string, number> = { cash: Number(z?.totals?.expectedCash ?? z?.shift?.expected_cash ?? 0) };
      for (const m of by) if (String(m.method).toLowerCase() !== 'cash') exp[String(m.method).toLowerCase()] = (exp[String(m.method).toLowerCase()] ?? 0) + Number(m.amount || 0);
      setExpected(exp);
      setCodes(['cash', ...methodsToDeclare(by)]);
    }).catch(() => setMsg('Could not read what this shift expects — you can still count and close it.'));
  }, [client, shift.id]);

  const variance = (c: string) => {
    const t = (inputs[c] ?? '').trim();
    return t === '' || !Number.isFinite(Number(t)) ? null : Math.round((Number(t) - (expected[c] ?? 0)) * 100) / 100;
  };
  const cashOff = (variance('cash') ?? 0) !== 0;

  const close = async () => {
    const r = readAmounts(inputs, codes);
    if (r.ok === false) { setMsg(`Enter what you counted for: ${r.missing.map((m) => methodName(m)).join(', ')}.`); return; }
    if (cashOff && !note.trim()) { setMsg('The cash is over or short — say why in the note.'); return; }
    if (behind && !behindOk) { setMsg('Tick that you understand the POS’s sales since it last synced are not in this close.'); return; }
    const { cash, ...others } = r.map;
    setBusy(true); setMsg('');
    try {
      await client.post(`/api/shifts/${shift.id}/close`, { closing_float: cash, declared_methods: others, notes: note.trim() || undefined,
        ...(unpaid && unpaidOk ? { ack_unpaid: true } : {}) });
      onDone();
    } catch (e: any) {
      if (e?.code === 'UNPAID_KITCHEN_ORDERS' && e?.may_override !== false) { setUnpaid(e?.message ?? 'Orders sent to the kitchen are unpaid.'); setUnpaidOk(false); }
      else setMsg(e?.message ?? 'Could not close this drawer.');
    }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-fade-in" data-testid="counted-close">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-lg w-full space-y-3 max-h-[90vh] overflow-y-auto animate-pop-in">
        <h3 className="text-white font-semibold">Close {shift.cashier_name}’s drawer{shift.terminal_code ? ` (${shift.terminal_code})` : ''} with your count</h3>
        <p className="text-gray-400 text-sm">Count each payment method — the drawer, the M-Pesa statement, the card machine’s total. What the shift expects is beside it; the difference shows as you type. It closes <strong className="text-gray-200">counted</strong>, under your name, and then waits for a manager’s confirmation.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-gray-500 text-left"><th className="font-normal">Method</th><th className="font-normal text-right pr-2">Expected</th><th className="font-normal">Counted</th><th className="font-normal text-right">Difference</th></tr></thead>
            <tbody>
              {codes.map((c) => {
                const v = variance(c);
                return (
                  <tr key={c}>
                    <td className="py-1 text-gray-200 whitespace-nowrap">{methodName(c)}</td>
                    <td className="py-1 pr-2 text-right text-gray-200 tabular-nums" data-testid={`cc-expected-${c}`}>{money(expected[c] ?? 0, currency)}</td>
                    <td className="py-1 w-28 sm:w-36"><input type="number" min={0} step="0.01" inputMode="decimal" value={inputs[c] ?? ''} data-testid={`cc-count-${c}`}
                      onWheel={(e) => (e.target as HTMLInputElement).blur()} onChange={(e) => setInputs({ ...inputs, [c]: e.target.value })}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" /></td>
                    <td className={`py-1 pl-2 text-right tabular-nums whitespace-nowrap ${v === null ? 'text-gray-500' : v === 0 ? 'text-gray-300' : v > 0 ? 'text-amber-300' : 'text-red-300'}`}>
                      {v === null ? '—' : v === 0 ? 'balanced' : `${v > 0 ? 'over' : 'short'} ${money(Math.abs(v), currency)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300}
          placeholder={cashOff ? 'Why the cash is over or short (required)' : 'Note (optional)'}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white" />
        {behind && (
          <label className="flex gap-2 items-start text-sm text-amber-300" data-testid="cc-behind">
            <input type="checkbox" checked={behindOk} onChange={(e) => setBehindOk(e.target.checked)} className="mt-1" />
            <span>{behind}</span>
          </label>
        )}
        {unpaid && (
          <label className="flex gap-2 items-start text-sm text-amber-300" data-testid="cc-unpaid">
            <input type="checkbox" checked={unpaidOk} onChange={(e) => setUnpaidOk(e.target.checked)} className="mt-1" />
            <span>{unpaid} Close anyway — the POS may be off; these orders stay open on it, to be charged or voided there.</span>
          </label>
        )}
        {msg && <p className="text-sm text-red-400">{msg}</p>}
        <div className="flex gap-3">
          <button onClick={onCancel} disabled={busy} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm py-2.5 rounded-lg">Cancel</button>
          <button onClick={() => void close()} disabled={busy || (!!behind && !behindOk) || (!!unpaid && !unpaidOk)} data-testid="cc-close"
            className="flex-1 bg-swift hover:bg-swift-light disabled:opacity-40 text-black font-semibold text-sm py-2.5 rounded-lg">
            {busy && <span className="spin-dot" aria-hidden />}
            {busy ? 'Closing…' : 'Close with this count'}
          </button>
        </div>
      </div>
    </div>
  );
}
