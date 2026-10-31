/**
 * BranchBillingCard — A612 phase 3 and 4: the cloud billed per branch, on the client's Plan & billing (under CloudPlanCard).
 *
 * Owner, 2026-10-30: "monthly subscription should be per branch for premium services or web — if a branch does not pay it
 * should not view its data" · invoices: one per business, to the owner · the items Cloud, Analytics, Attendance, Themes ·
 * "one premium package that of 15000 that covers all the items". (docs/A612-per-branch-cloud.md)
 *
 * Billed as one business: a note and (super admin) "Bill per branch" — every branch gets the business's plan and paid-until.
 * Billed per branch: each branch's plan, premium, package, "Disable", paid-until and where it stands; Record payment for the
 * branches ticked (each moves on one of its own periods — the cloud says what it covers and the amount expected first).
 * Cloud: routes/cloudPlanAdmin.ts (…/cloud-plan/branches/*, …/branch-payments).
 */
import { useCallback, useEffect, useState } from "react";
import { C, S } from "./theme";
import { standingLine, trialDate, type CloudStandingView } from "./cloudPlan";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;
interface BranchPlan { period: string; amount: number; custom_until: string | null; paid_until: string | null; web_off: boolean; premium: string[]; package: boolean }
interface BranchRow { branch_id: string; name: string | null; is_main: boolean; plan: BranchPlan | null; premium: string[]; package: boolean; standing: CloudStandingView | null; period_total: number | null }
interface Prices { cloud: number; analytics: number; attendance: number; themes: number; package: number }
interface View { per_branch: boolean; branches: BranchRow[]; prices: Prices; plan: { period: string } | null; defaults: { periods: Array<{ value: string; label: string }>; methods: string[] } }
interface Preview { expected: number; branches: Array<{ branch_id: string; name: string; from: string; until: string; fresh: boolean }> }

const TONE: Record<string, string> = { ok: "#34e5a0", warn: "#f59e0b", bad: C.danger, muted: C.muted };
const kes = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `KES ${Number(n).toLocaleString("en-KE")}`);
const PREMIUM: Array<[string, string]> = [["analytics", "Analytics"], ["attendance", "Attendance"], ["themes", "Themes"]];
const METHOD: Record<string, string> = { mpesa: "M-Pesa", bank: "Bank", cash: "Cash", other: "Other" };
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export default function BranchBillingCard({ clientId, req, isSuper, onChanged }: { clientId: string; req: Req; isSuper: boolean; onChanged?: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ branch_id: string; period: string; amount: string; premium: string[]; package: boolean; web_off: boolean } | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [method, setMethod] = useState("mpesa");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [note, setNote] = useState("");

  const adopt = useCallback((v: View) => {
    setView(v);
    // the branches owing by default: unpaid, locked or not interested
    setTicked(v.branches.filter((b) => b.plan && ["unpaid", "locked", "not_interested"].includes(b.standing?.state ?? "")).map((b) => b.branch_id));
  }, []);
  const load = useCallback(() => { req("GET", `/clients/${clientId}/cloud-plan`).then(adopt).catch((e) => setError(e.message)); }, [clientId, req, adopt]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!view?.per_branch || !ticked.length) { setPreview(null); return; }
    let live = true;
    const t = setTimeout(() => {
      req("POST", `/clients/${clientId}/cloud-plan/branch-payments/preview`, { branch_ids: ticked })
        .then((p: Preview) => { if (live) { setPreview(p); setPayAmount(String(p.expected)); } })
        .catch(() => { if (live) setPreview(null); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [view, ticked, clientId, req]);

  const run = async (fn: () => Promise<any>, done: (v: any) => string) => {
    setBusy(true); setError(null); setNotice(null);
    try { const v = await fn(); adopt(v); setNotice(done(v)); onChanged?.(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (!view) return <div style={S.card}><div style={{ fontSize: 12, color: error ? C.danger : C.muted }}>{error ?? "Loading the branches' plans…"}</div></div>;
  const label = (p: string) => view.defaults.periods.find((x) => x.value === p)?.label ?? p;
  const field = (title: string, el: React.ReactNode) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted, minWidth: 120, flex: 1 }}>{title}{el}</label>
  );

  if (!view.per_branch) {
    return (
      <div style={S.card} data-testid="branch-billing">
        <div style={{ fontSize: 13, fontWeight: 600 }}>Cloud per branch</div>
        <div style={{ fontSize: 12, color: C.muted, margin: "8px 0" }}>
          This client is billed as one business. Billed per branch, each branch has its own plan, premium and paid-until; a branch that
          does not pay is cut off on its own (its POS stop syncing, nobody sees its data) and the owner gets one invoice for the branches due.
        </div>
        {isSuper && (
          <button data-testid="branches-start" disabled={busy || !view.plan} title={view.plan ? undefined : "Set the plan first"}
            onClick={() => run(() => req("POST", `/clients/${clientId}/cloud-plan/branches/start`), () => "Billed per branch from now: every branch has the business's plan and paid-until.")}
            style={{ ...S.btn, ...S.btnGhost, opacity: busy || !view.plan ? 0.5 : 1 }}>Bill per branch</button>
        )}
        {notice && <div style={{ fontSize: 12, color: "#34e5a0", marginTop: 8 }}>{notice}</div>}
        {error && <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>{error}</div>}
      </div>
    );
  }

  const saveBranch = () => edit && run(() => req("PUT", `/clients/${clientId}/cloud-plan/branches/${edit.branch_id}`, {
    period: edit.period, amount: Number(edit.amount), premium: edit.premium, package: edit.package, web_off: edit.web_off,
  }), () => { setEdit(null); return "Branch plan saved."; });

  return (
    <div style={S.card} data-testid="branch-billing">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Cloud per branch</div>
        <div style={{ fontSize: 11, color: C.muted }}>
          A month: Cloud {kes(view.prices.cloud)} · Analytics {kes(view.prices.analytics)} · Attendance {kes(view.prices.attendance)} · Themes {kes(view.prices.themes)} · Premium package {kes(view.prices.package)}
        </div>
      </div>
      {notice && <div style={{ fontSize: 12, color: "#34e5a0", margin: "8px 0" }}>{notice}</div>}
      {error && <div style={{ fontSize: 12, color: C.danger, margin: "8px 0" }}>{error}</div>}

      <div className="sp-table-wrap" style={{ marginTop: 10 }}><table style={S.table} data-testid="branch-plans">
        <thead><tr>{["Branch", "Plan", "Premium", "Paid until", "Where it stands", "A period", ""].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
        <tbody>{view.branches.map((b) => {
          const line = standingLine(b.standing);
          return (
            <tr key={b.branch_id}>
              <td style={{ ...S.td, fontWeight: 600 }}>{b.name}{b.is_main ? " ★" : ""}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{b.plan ? `${label(b.plan.period)} · ${kes(b.plan.amount)}` : <span style={{ color: C.muted }}>Follows the business</span>}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{b.package ? "Premium package" : b.premium.length ? b.premium.map((k) => PREMIUM.find((p) => p[0] === k)?.[1] ?? k).join(", ") : "—"}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{b.plan ? trialDate(b.plan.paid_until) : "—"}</td>
              <td style={{ ...S.td, fontSize: 12, color: TONE[line.tone] }}>{b.plan?.web_off ? "Disabled" : line.title}</td>
              <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{kes(b.period_total)}</td>
              <td style={S.td}>{isSuper && (
                <button data-testid={`branch-edit-${b.branch_id}`} style={{ ...S.btn, ...S.btnGhost, fontSize: 11 }}
                  onClick={() => setEdit({ branch_id: b.branch_id, period: b.plan?.period ?? view.plan?.period ?? "monthly", amount: String(b.plan?.amount ?? view.prices.cloud),
                    premium: b.plan?.premium ?? [], package: !!b.plan?.package, web_off: !!b.plan?.web_off })}>Edit</button>
              )}</td>
            </tr>
          );
        })}</tbody>
      </table></div>

      {edit && (
        <div data-testid="branch-edit" style={{ marginTop: 12, padding: 12, borderRadius: 12, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{view.branches.find((b) => b.branch_id === edit.branch_id)?.name}</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            {field("Period", <select style={S.input} value={edit.period} onChange={(e) => setEdit({ ...edit, period: e.target.value })}>
              {view.defaults.periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>)}
            {field("Cloud, per period (KES)", <input style={S.input} inputMode="numeric" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} />)}
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, fontSize: 12 }}>
            <label><input type="checkbox" checked={edit.package} onChange={(e) => setEdit({ ...edit, package: e.target.checked })} /> Premium package (Cloud and every premium item)</label>
            {PREMIUM.map(([k, n]) => (
              <label key={k} style={{ opacity: edit.package ? 0.5 : 1 }}>
                <input type="checkbox" disabled={edit.package} checked={edit.package || edit.premium.includes(k)}
                  onChange={(e) => setEdit({ ...edit, premium: e.target.checked ? [...edit.premium, k] : edit.premium.filter((x) => x !== k) })} /> {n}
              </label>
            ))}
            <label style={{ color: C.danger }}><input type="checkbox" checked={edit.web_off} onChange={(e) => setEdit({ ...edit, web_off: e.target.checked })} /> Disable this branch now</label>
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Premium needs the business's own switch on too (Features). Disable cuts the branch off at once: its POS stop syncing and nobody sees its data.</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button data-testid="branch-save" disabled={busy || !edit.amount} onClick={saveBranch} style={{ ...S.btn, ...S.btnPrimary, opacity: busy ? 0.5 : 1 }}>Save</button>
            <button onClick={() => setEdit(null)} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, margin: "18px 0 8px" }}>Record payment for branches</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12 }}>
        {view.branches.filter((b) => b.plan).map((b) => (
          <label key={b.branch_id}><input type="checkbox" data-testid={`pay-branch-${b.branch_id}`} checked={ticked.includes(b.branch_id)} disabled={!isSuper}
            onChange={(e) => setTicked(e.target.checked ? [...ticked, b.branch_id] : ticked.filter((x) => x !== b.branch_id))} /> {b.name}</label>
        ))}
      </div>
      {preview && (
        <div data-testid="branch-pay-covers" style={{ fontSize: 12, color: "#34e5a0", marginTop: 8 }}>
          Expected {kes(preview.expected)} — {preview.branches.map((p) => `${p.name}: ${trialDate(p.from)} – ${trialDate(p.until)}${p.fresh ? " (afresh; its locked time not charged)" : ""}`).join(" · ")}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
        {field("Amount paid (KES)", <input data-testid="branch-pay-amount" disabled={!isSuper} style={S.input} inputMode="numeric" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />)}
        {field("Method", <select disabled={!isSuper} style={S.input} value={method} onChange={(e) => setMethod(e.target.value)}>
          {view.defaults.methods.map((m) => <option key={m} value={m}>{METHOD[m] ?? m}</option>)}
        </select>)}
        {field(method === "mpesa" ? "M-Pesa code" : "Reference", <input disabled={!isSuper} style={S.input} placeholder={method === "mpesa" ? "e.g. SJK4H7Q2LM" : "optional"} value={reference} onChange={(e) => setReference(e.target.value)} />)}
        {field("Paid on", <input type="date" disabled={!isSuper} style={S.input} value={paidAt} max={today()} onChange={(e) => setPaidAt(e.target.value)} />)}
        {field("Note (optional)", <input disabled={!isSuper} style={S.input} value={note} onChange={(e) => setNote(e.target.value)} />)}
        {isSuper
          ? <button data-testid="branch-pay-record" disabled={busy || !ticked.length || !payAmount || (method === "mpesa" && !reference.trim())}
              onClick={() => run(() => req("POST", `/clients/${clientId}/cloud-plan/branch-payments`, {
                branch_ids: ticked, amount: Number(payAmount), method, reference: reference.trim() || null,
                paid_at: paidAt ? new Date(`${paidAt}T12:00:00+03:00`).toISOString() : null, note: note.trim() || null,
              }), (v) => { setReference(""); setNote(""); return `Payment recorded — ${(v.paid_branches ?? []).map((x: any) => `${x.name} paid until ${trialDate(x.until)}`).join("; ")}${v.invoice_number ? `; invoice ${v.invoice_number} (paid)` : ""}${(v.not_charged ?? []).length ? `; ${v.not_charged.join(", ")} closed, not charged` : ""}.`; })}
              style={{ ...S.btn, ...S.btnPrimary, opacity: busy || !ticked.length || !payAmount ? 0.5 : 1 }}>Record payment</button>
          : <span style={{ fontSize: 11, color: C.muted }}>Super admin only</span>}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 12 }}>
        Each branch has its own due date and 7 unpaid days. The owner gets one invoice for the branches due the same day. A branch that does not pay is cut off on its own; the others carry on.
      </div>
    </div>
  );
}
