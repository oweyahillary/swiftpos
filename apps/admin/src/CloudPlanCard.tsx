/**
 * CloudPlanCard — A581: the client's cloud payment plan on Plan & billing.
 *
 * Owner, 2026-10-23: "add payment plan option such that i can select month on month and always remind me on email about
 * expiry and also the client". The plan (Monthly / 3 / 6 / 12 months / Custom end date, an amount per period — KES 3,000 a
 * month by default, editable), where the client stands (paid-until, days left, the 21-day grace, sync stopped), Record
 * payment (amount, M-Pesa code, date paid — paid-until moves one period on from the later of today and the current
 * paid-until), the payments and the reminders sent. Cloud: /api/admin/clients/:id/cloud-plan (routes/cloudPlanAdmin.ts).
 * Payment detection is manual for now: nothing here takes money, and a monthly plan does not renew by itself.
 * A584: the ONE way to turn web access on — Record payment, or (super admin, a special case) a complimentary paid-until
 * with a reason, audited. The standing reads due / unpaid N days (locks in M) / locked; the notices listed are ZapTill's
 * (the client gets only the invoice and a receipt).
 */
import { useCallback, useEffect, useState } from "react";
import { C, S } from "./theme";
import { standingLine, milestoneText, periodDefault, trialDate, type CloudStandingView } from "./cloudPlan";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;
interface Plan { period: string; amount: number; currency: string; custom_until: string | null; notes: string | null; updated_by: string | null; updated_at?: string }
interface Payment { id: string; amount: number; currency: string; period: string; method: string; reference: string | null; paid_at: string;
  paid_until_before: string | null; paid_until_after: string; recorded_by_email: string; recorded_at: string; note: string | null }
interface Reminder { milestone: string; paid_until: string; sent_at: string; owner_sent: boolean; admin_sent: boolean; error: string | null }
interface View {
  plan: Plan | null; standing: CloudStandingView | null; payments: Payment[]; reminders: Reminder[];
  defaults: { monthly: number; periods: Array<{ value: string; label: string; amount: number | null }>; methods: string[] };
}

const TONE: Record<string, string> = { ok: "#34e5a0", warn: "#f59e0b", bad: C.danger, muted: C.muted };
const kes = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `KES ${Number(n).toLocaleString("en-KE")}`);
const METHOD: Record<string, string> = { mpesa: "M-Pesa", bank: "Bank", cash: "Cash", other: "Other" };
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export default function CloudPlanCard({ clientId, clientName, req, isSuper, onChanged }:
  { clientId: string; clientName: string; req: Req; isSuper: boolean; onChanged?: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // plan editor
  const [period, setPeriod] = useState("monthly");
  const [amount, setAmount] = useState("3000");
  const [customUntil, setCustomUntil] = useState("");
  // record payment
  const [payAmount, setPayAmount] = useState("");
  const [payPeriod, setPayPeriod] = useState("monthly");
  const [method, setMethod] = useState("mpesa");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [payUntil, setPayUntil] = useState("");
  const [note, setNote] = useState("");
  // A584: complimentary / manual paid-until
  const [compUntil, setCompUntil] = useState("");
  const [compReason, setCompReason] = useState("");

  const adopt = useCallback((v: View) => {
    setView(v);
    const p = v.plan;
    setPeriod(p?.period ?? "monthly");
    setAmount(p ? String(Number(p.amount)) : periodDefault("monthly", v.defaults.monthly));
    setCustomUntil(p?.custom_until ? p.custom_until.slice(0, 10) : "");
    setPayPeriod(p?.period ?? "monthly");
    setPayAmount(p ? String(Number(p.amount)) : periodDefault("monthly", v.defaults.monthly));
  }, []);

  const load = useCallback(() => {
    req("GET", `/clients/${clientId}/cloud-plan`).then(adopt).catch((e) => setError(e.message));
  }, [clientId, req, adopt]);
  useEffect(() => { load(); }, [load]);

  async function savePlan() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const v = await req("PUT", `/clients/${clientId}/cloud-plan`, { period, amount: Number(amount), custom_until: period === "custom" ? customUntil || null : null });
      adopt(v); setNotice("Plan saved.");
      onChanged?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function recordPayment() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const v = await req("POST", `/clients/${clientId}/cloud-plan/payments`, {
        amount: Number(payAmount), period: payPeriod, method, reference: reference.trim() || null,
        paid_at: paidAt ? new Date(`${paidAt}T12:00:00+03:00`).toISOString() : null,
        paid_until: payPeriod === "custom" ? (payUntil ? new Date(`${payUntil}T23:59:00+03:00`).toISOString() : null) : null, note: note.trim() || null,
      });
      adopt(v);
      setReference(""); setNote(""); setPayUntil("");
      setNotice(`Payment recorded — paid until ${trialDate(v.payment?.paid_until_after)}${v.trial_converted ? "; the cloud trial is converted" : ""}${v.invoice_number ? `; invoice ${v.invoice_number} (paid)` : ""}${v.receipt_sent ? "; receipt emailed" : ""}. Web access and sync are open.`);
      onChanged?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function complimentary() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const v = await req("POST", `/clients/${clientId}/cloud-plan/complimentary`, {
        paid_until: compUntil ? new Date(`${compUntil}T23:59:00+03:00`).toISOString() : null, reason: compReason.trim(),
      });
      adopt(v); setCompUntil(""); setCompReason("");
      setNotice(`Complimentary paid-until set — ${trialDate(v.paid_until)}. Web access is on; no invoice raised; audited.`);
      onChanged?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (!view) return <div style={S.card}><div style={{ fontSize: 12, color: error ? C.danger : C.muted }}>{error ?? "Loading the cloud plan…"}</div></div>;
  const line = standingLine(view.standing);
  const label = (p: string) => view.defaults.periods.find((x) => x.value === p)?.label ?? p;
  const field = (title: string, el: React.ReactNode) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted, minWidth: 130, flex: 1 }}>{title}{el}</label>
  );

  return (
    <div style={S.card} data-testid="cloud-plan-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Cloud plan (per business)</div>
        <div style={{ fontSize: 11, color: C.muted }}>Web dashboard, online features and sync · default KES {view.defaults.monthly.toLocaleString("en-KE")} a month · no discount for paying ahead</div>
      </div>
      <div data-testid="cloud-plan-standing" style={{ margin: "12px 0", padding: "10px 14px", borderRadius: 12, border: `1px solid ${TONE[line.tone]}55`, background: `${TONE[line.tone]}14` }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: TONE[line.tone] }}>{line.title}</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{line.text}</div>
      </div>
      {notice && <div style={{ fontSize: 12, color: "#34e5a0", marginBottom: 10 }}>{notice}</div>}
      {error && <div style={{ fontSize: 12, color: C.danger, marginBottom: 10 }}>{error}</div>}

      <div style={{ fontSize: 12, fontWeight: 600, margin: "6px 0 8px" }}>Plan</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        {field("Period", <select data-testid="plan-period" disabled={!isSuper} style={S.input} value={period}
          onChange={(e) => { setPeriod(e.target.value); const d = periodDefault(e.target.value, view.defaults.monthly); if (d) setAmount(d); }}>
          {view.defaults.periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>)}
        {field("Amount per period (KES)", <input data-testid="plan-amount" disabled={!isSuper} style={S.input} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />)}
        {period === "custom" && field("Paid until (custom)", <input type="date" disabled={!isSuper} style={S.input} value={customUntil} onChange={(e) => setCustomUntil(e.target.value)} />)}
        {isSuper
          ? <button data-testid="plan-save" disabled={busy || !amount} onClick={savePlan} style={{ ...S.btn, ...S.btnGhost, opacity: busy ? 0.5 : 1 }}>Save plan</button>
          : <span style={{ fontSize: 11, color: C.muted }}>Super admin only</span>}
      </div>
      {view.plan && <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Now: {label(view.plan.period)} · {kes(view.plan.amount)}{view.plan.updated_by ? ` · set by ${view.plan.updated_by}` : ""}</div>}

      <div style={{ fontSize: 12, fontWeight: 600, margin: "18px 0 8px" }}>Record payment</div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
        {view.standing?.state === "unpaid" && view.standing.due_at
          ? <>This payment covers the invoiced period, from {trialDate(view.standing.due_at)}. </>
          : <>Paid-until moves on one period from the later of today and {view.standing?.paid_until ? trialDate(view.standing.paid_until) : "today"} — paying early never loses a day. </>}
        Payments are checked by hand for now (M-Pesa Daraja later); a monthly plan needs a payment each month.
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        {field("Covers", <select data-testid="pay-period" disabled={!isSuper} style={S.input} value={payPeriod}
          onChange={(e) => { setPayPeriod(e.target.value); const d = e.target.value === view.plan?.period ? String(Number(view.plan.amount)) : periodDefault(e.target.value, view.defaults.monthly); if (d) setPayAmount(d); }}>
          {view.defaults.periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>)}
        {payPeriod === "custom" && field("Paid until", <input type="date" disabled={!isSuper} style={S.input} value={payUntil} onChange={(e) => setPayUntil(e.target.value)} />)}
        {field("Amount paid (KES)", <input data-testid="pay-amount" disabled={!isSuper} style={S.input} inputMode="numeric" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />)}
        {field("Method", <select disabled={!isSuper} style={S.input} value={method} onChange={(e) => setMethod(e.target.value)}>
          {view.defaults.methods.map((m) => <option key={m} value={m}>{METHOD[m] ?? m}</option>)}
        </select>)}
        {field(method === "mpesa" ? "M-Pesa code" : "Reference", <input data-testid="pay-reference" disabled={!isSuper} style={{ ...S.input, textTransform: reference ? "uppercase" : "none" }} placeholder={method === "mpesa" ? "e.g. SJK4H7Q2LM" : "optional"} value={reference} onChange={(e) => setReference(e.target.value)} />)}
        {field("Paid on", <input type="date" disabled={!isSuper} style={S.input} value={paidAt} max={today()} onChange={(e) => setPaidAt(e.target.value)} />)}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        {field("Note (optional)", <input disabled={!isSuper} style={S.input} value={note} onChange={(e) => setNote(e.target.value)} />)}
        {isSuper
          ? <button data-testid="pay-record" disabled={busy || !payAmount || (method === "mpesa" && !reference.trim())} onClick={recordPayment}
              style={{ ...S.btn, ...S.btnPrimary, opacity: busy || !payAmount || (method === "mpesa" && !reference.trim()) ? 0.5 : 1 }}>
              Record payment{view.standing?.trial ? " (converts the trial)" : ""}</button>
          : <span style={{ fontSize: 11, color: C.muted }}>Super admin only</span>}
      </div>

      {isSuper && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, margin: "18px 0 8px" }}>Complimentary / manual paid-until</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>For a special case only: no payment, no invoice. Web access is turned on to the date you choose; the reason is kept in the audit log.</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            {field("Paid until", <input data-testid="comp-until" type="date" style={S.input} value={compUntil} min={today()} onChange={(e) => setCompUntil(e.target.value)} />)}
            {field("Reason (required)", <input data-testid="comp-reason" style={S.input} value={compReason} placeholder="e.g. launch partner, 3 months free" onChange={(e) => setCompReason(e.target.value)} />)}
            <button data-testid="comp-save" disabled={busy || !compUntil || compReason.trim().length < 3} onClick={complimentary}
              style={{ ...S.btn, ...S.btnGhost, opacity: busy || !compUntil || compReason.trim().length < 3 ? 0.5 : 1 }}>Set complimentary</button>
          </div>
        </>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, margin: "18px 0 8px" }}>Payments</div>
      {view.payments.length === 0 ? <div style={{ fontSize: 12, color: C.muted }}>No cloud payments recorded yet.</div> : (
        <div className="sp-table-wrap"><table style={S.table} data-testid="cloud-payments">
          <thead><tr>{["Paid on", "Amount", "Covers", "Reference", "Paid until", "Recorded by"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>{view.payments.map((p) => (
            <tr key={p.id}>
              <td style={{ ...S.td, fontSize: 12 }}>{trialDate(p.paid_at)}</td>
              <td style={{ ...S.td, fontFamily: "monospace" }}>{kes(p.amount)}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{label(p.period)}</td>
              <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{METHOD[p.method] ?? p.method}{p.reference ? ` · ${p.reference}` : ""}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{p.paid_until_before ? `${trialDate(p.paid_until_before)} → ` : ""}<b>{trialDate(p.paid_until_after)}</b></td>
              <td style={{ ...S.td, fontSize: 11, color: C.muted }}>{p.recorded_by_email}<br />{new Date(p.recorded_at).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {view.reminders.length > 0 && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 12 }} data-testid="cloud-reminders">
          Notices sent: {view.reminders.map((r) => `${milestoneText(r.milestone)} (${trialDate(r.sent_at)}${r.owner_sent ? "" : ", owner not reached"}${r.admin_sent ? "" : ", ZapTill not reached"})`).join(" · ")}
        </div>
      )}
      <div style={{ fontSize: 11, color: C.muted, marginTop: 12 }}>{clientName}'s tills never stop selling. On each due date the client is emailed the invoice (nothing else). Unpaid 7 days after it, everything locks at once — web dashboard paused, sync stopped, no till joins; a recorded payment opens it again at once.</div>
    </div>
  );
}
