/**
 * TestDataCard — A396: clear a client's test data between two times (client › Owner & account).
 *
 * Owner, 2026-10-04: "the purge i should be able to select the date it starts and time (which the system should give by
 * default) and the date and time testing stopped so that i should not purge a real sale". The start defaults to when the
 * client was set up and the end to now; the preview shows what falls inside, the first and last test sale, and the first
 * sale AFTER the window (so a real sale is never caught). The clear itself is one database transaction on the cloud
 * (migration 122) — super admin only, the client's name typed to confirm.
 */
import { useEffect, useState } from "react";
import { C, S } from "./theme";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface Counts { [k: string]: number | string | null }
interface Preview {
  business: { id: string; name: string };
  defaults: { from: string; to: string };
  window: { from: string; to: string };
  preview: { ok: boolean; problems: string[]; counts: Counts };
  tills_behind: Array<{ name: string; last_sync_at: string | null }>;
  history: Array<{ from_at: string; to_at: string; stock_mode: string; counts: Counts; done_by: string | null; created_at: string }>;
}

/** ISO → the value a datetime-local box shows (the admin's own clock). */
const toLocal = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocal = (v: string) => new Date(v).toISOString();
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" }) : "—");

const LABELS: Array<[string, string]> = [
  ["sales", "Sales"], ["payments", "Payments"], ["shifts", "Shifts"], ["trading_days", "Trading days"], ["cash_in_out", "Cash in / out"],
  ["expenses", "Expenses"], ["stock_movements", "Stock movements"], ["stock_counts", "Stock counts"], ["transfers", "Transfers"],
  ["purchase_orders", "Purchase orders"], ["deliveries", "Deliveries"], ["supplier_bills", "Supplier bills"],
  ["supplier_payments", "Supplier payments"], ["supplier_returns", "Supplier returns"], ["reservations", "Reservations"],
  ["customers_created", "Customers added"],
];

export default function TestDataCard({ clientId, req, isSuper }: { clientId: string; req: Req; isSuper: boolean }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [stock, setStock] = useState<"undo" | "zero" | "keep">("undo");
  const [customers, setCustomers] = useState(true);
  const [data, setData] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = async (f?: string, t?: string) => {
    setBusy(true); setError("");
    try {
      const qs = new URLSearchParams({ stock, customers: String(customers) });
      if (f) qs.set("from", fromLocal(f));
      if (t) qs.set("to", fromLocal(t));
      const d: Preview = await req("GET", `/clients/${clientId}/test-data?${qs}`);
      setData(d);
      if (!f) setFrom(toLocal(d.window.from));
      if (!t) setTo(toLocal(d.window.to));
    } catch (e: any) { setError(e?.message || "Could not load the preview."); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (open && !data) void load(); }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const clear = async () => {
    if (!data) return;
    setBusy(true); setError(""); setDone("");
    try {
      const r = await req("POST", `/clients/${clientId}/test-data/clear`, {
        from: fromLocal(from), to: fromLocal(to), stock_mode: stock, delete_customers: customers, confirm_name: confirm,
      });
      setDone(`Cleared: ${r.counts?.sales ?? 0} sales, ${r.counts?.shifts ?? 0} shifts, ${r.counts?.expenses ?? 0} expenses and the rest of the window.`);
      setConfirm(""); setData(null); await load(from, to);
    } catch (e: any) { setError(e?.message || "Nothing was cleared."); }
    finally { setBusy(false); }
  };

  const c = data?.preview.counts ?? {};
  const problems = data?.preview.problems ?? [];
  const nothing = data && Number(c.sales ?? 0) === 0 && LABELS.every(([k]) => Number(c[k] ?? 0) === 0);
  const canClear = isSuper && data && problems.length === 0 && !nothing && confirm.trim().toLowerCase() === data.business.name.trim().toLowerCase();
  const input = { ...S.input, maxWidth: 230 } as const;

  return (
    <div style={{ ...S.card, borderColor: "rgba(255,92,108,0.3)" }} data-testid="test-data-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.danger }}>Clear test data</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Remove the sales, shifts and stock activity made while testing — before the client starts trading. Menu, staff, branches, tills and settings stay.</div>
        </div>
        {!open && <button onClick={() => setOpen(true)} style={{ ...S.btn, ...S.btnDanger, fontSize: 12 }}>Clear test data…</button>}
      </div>

      {open && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ fontSize: 12, color: C.muted }}>Testing started<br />
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} style={input} data-testid="test-from" /></label>
            <label style={{ fontSize: 12, color: C.muted }}>Testing stopped<br />
              <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} style={input} data-testid="test-to" /></label>
            <label style={{ fontSize: 12, color: C.muted }}>Stock<br />
              <select value={stock} onChange={(e) => setStock(e.target.value as typeof stock)} style={input}>
                <option value="undo">Put back as before testing</option>
                <option value="zero">Set everything to 0</option>
                <option value="keep">Leave as it is</option>
              </select></label>
            <label style={{ fontSize: 12, color: C.muted, display: "flex", gap: 6, alignItems: "center", paddingBottom: 8 }}>
              <input type="checkbox" checked={customers} onChange={(e) => setCustomers(e.target.checked)} /> Remove customers added while testing</label>
            <button disabled={busy || !from || !to} onClick={() => load(from, to)} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>{busy ? "Checking…" : "Show what will be removed"}</button>
          </div>
          {data && <div style={{ fontSize: 11, color: C.muted }}>Defaults: set up {when(data.defaults.from)} → now. Change them to the exact start and end of testing.</div>}

          {data && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }} data-testid="test-data-counts">
              {LABELS.map(([k, l]) => (
                <div key={k} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 10px" }}>
                  <div style={{ fontSize: 11, color: C.muted }}>{l}</div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{Number(c[k] ?? 0)}</div>
                </div>
              ))}
            </div>
          )}
          {data && Number(c.sales ?? 0) > 0 && (
            <div style={{ fontSize: 12, color: C.text, lineHeight: 1.6 }}>
              Test sales from <b>{when(c.first_sale as string)}</b> to <b>{when(c.last_sale as string)}</b> — KES {Number(c.sales_value ?? 0).toLocaleString("en-KE")}.<br />
              First sale after the window: <b>{c.next_sale_after ? when(c.next_sale_after as string) : "none yet"}</b> — it stays.
            </div>
          )}
          {data && Number(c.customers_touched_before ?? 0) > 0 && (
            <div style={{ fontSize: 12, color: C.muted }}>{c.customers_touched_before} customer(s) added before testing earned points or credit in it — their balances are not changed; correct them on the dashboard if needed.</div>
          )}
          {data && data.tills_behind.length > 0 && (
            <div style={{ fontSize: 12, color: "#f59e0b" }} data-testid="tills-behind">
              Not synced since testing stopped: {data.tills_behind.map((t) => `${t.name} (${t.last_sync_at ? when(t.last_sync_at) : "never"})`).join(", ")}.
              Such a till may still hold test sales it has not sent — sync it first, or clear again after it has.
            </div>
          )}
          {problems.length > 0 && (
            <div style={{ fontSize: 12, color: C.danger, lineHeight: 1.6 }} data-testid="test-data-problems">{problems.map((p) => <div key={p}>• {p}</div>)}</div>
          )}
          {nothing && <div style={{ fontSize: 12, color: C.muted }}>Nothing in this window.</div>}

          {data && problems.length === 0 && !nothing && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`Type "${data.business.name}" to confirm`} style={{ ...S.input, maxWidth: 300 }} data-testid="test-confirm" />
              <button disabled={!canClear || busy} onClick={clear} data-testid="test-clear"
                style={{ ...S.btn, ...S.btnDanger, fontSize: 12, opacity: canClear && !busy ? 1 : 0.5 }}>{busy ? "Clearing…" : "Clear test data"}</button>
              {!isSuper && <span style={{ fontSize: 12, color: C.muted }}>Only a super admin can clear.</span>}
            </div>
          )}
          {error && <div style={{ fontSize: 12, color: C.danger }}>{error}</div>}
          {done && <div style={{ fontSize: 12, color: "#34e5a0" }}>{done}</div>}

          {data && data.history.length > 0 && (
            <div style={{ fontSize: 12, color: C.muted }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Earlier clears</div>
              {data.history.map((h) => (
                <div key={h.created_at}>{when(h.created_at)} — {when(h.from_at)} → {when(h.to_at)}: {Number(h.counts?.sales ?? 0)} sales{h.done_by ? ` · ${h.done_by}` : ""}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
