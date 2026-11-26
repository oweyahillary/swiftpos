/**
 * CloudBillingSettingsCard — A626 Phase 1: ZapTill's cloud-billing M-Pesa Paybill (clients pay their subscription with a
 * code). ZapTill-global, on the Billing page. Super admin registers the Paybill's C2B callback with Safaricom and fires a
 * sandbox test; the raw receipts feed shows payments landing. Matching to a client + the credit wallet are Phase 2.
 *
 * Daraja keys are env vars on the server (ZAPTILL_MPESA_*); this screen never sees them. Routes: /api/admin/cloud-billing/*.
 */
import { useCallback, useEffect, useState } from "react";
import { C, S } from "./theme";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;
interface Settings { configured: boolean; server_environment: string; table: boolean;
  registered: { at: string | null; shortcode: string | null; environment: string | null; last_error: string | null } | null }
interface Receipt { id: string; trans_id: string; amount: number; bill_ref: string | null; first_name: string | null; created_at: string; status: string; business_id: string | null; business_name?: string | null }

const kes = (n: number) => `KES ${Number(n).toLocaleString("en-KE")}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" }) : "—");

export default function CloudBillingSettingsCard({ req, isSuper }: { req: Req; isSuper: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testRef, setTestRef] = useState("");
  const [testAmount, setTestAmount] = useState("1");
  const [assignDraft, setAssignDraft] = useState<Record<string, string>>({});

  const loadReceipts = useCallback(() => { req("GET", "/cloud-billing/receipts").then((r) => setReceipts(r.receipts ?? [])).catch(() => {}); }, [req]);
  const load = useCallback(() => {
    req("GET", "/cloud-billing/settings").then((v: Settings) => { setS(v); }).catch((e) => setError(e.message));
    loadReceipts();
  }, [req, loadReceipts]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<any>, ok: (v: any) => string) => {
    setBusy(true); setError(null); setNotice(null);
    try { const v = await fn(); setNotice(ok(v)); load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const reverse = (r: Receipt) => {
    if (!window.confirm(`Reverse ${kes(r.amount)} (${r.trans_id})?\n\nZapTill claws back up to that much from the client's credit. If it was already applied to an invoice, the invoice stays paid and the shortfall is flagged for you to re-invoice — nothing is silently locked.`)) return;
    run(() => req("POST", `/cloud-billing/receipts/${r.id}/reverse`),
      (v) => v.already ? "That payment was already reversed." : `Reversed. Clawed back ${kes(v.clawback)}${v.shortfall > 0 ? `; ${kes(v.shortfall)} was already spent on an invoice — re-invoice if needed.` : "."}`);
  };

  if (!s) return <div style={S.card}><div style={{ fontSize: 12, color: error ? C.danger : C.muted }}>{error ?? "Loading cloud billing…"}</div></div>;

  const reg = s.registered;
  const sandboxReady = !!reg?.shortcode && reg.environment === "sandbox";

  return (
    <div style={S.card} data-testid="cloud-billing-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Cloud billing — M-Pesa Paybill</div>
        <div style={{ fontSize: 11, color: C.muted }}>Clients pay their subscription to ZapTill's Paybill with their code as the account number. Environment: <b>{s.server_environment}</b></div>
      </div>

      {!s.table && <div style={{ fontSize: 12, color: C.danger, margin: "8px 0" }}>The database update (migration 195) has not run yet.</div>}
      {notice && <div style={{ fontSize: 12, color: "#34e5a0", margin: "8px 0" }}>{notice}</div>}
      {error && <div style={{ fontSize: 12, color: C.danger, margin: "8px 0" }}>{error}</div>}

      <div data-testid="cloud-billing-status" style={{ margin: "12px 0", padding: "10px 14px", borderRadius: 12, border: `1px solid ${C.border}`, fontSize: 12, lineHeight: 1.7 }}>
        <div>Daraja keys (server env): <b style={{ color: s.configured ? "#34e5a0" : C.danger }}>{s.configured ? "set" : "not set"}</b>{!s.configured && <span style={{ color: C.muted }}> — set ZAPTILL_MPESA_CONSUMER_KEY / _SECRET / _SHORTCODE on the server</span>}</div>
        <div>Registered with Safaricom: {reg?.at
          ? <b style={{ color: "#34e5a0" }}>{reg.shortcode} ({reg.environment}) · {when(reg.at)}</b>
          : <b style={{ color: C.muted }}>not registered</b>}</div>
        {reg?.last_error && <div style={{ color: C.danger }}>Last error: {reg.last_error}</div>}
      </div>

      {isSuper ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <button data-testid="cloud-billing-register" disabled={busy || !s.configured} onClick={() => run(() => req("POST", "/cloud-billing/register"), (v) => `Registered ${v.shortcode} with Safaricom (${v.environment}).`)}
            style={{ ...S.btn, ...S.btnPrimary, opacity: busy || !s.configured ? 0.5 : 1 }}>Register with Safaricom</button>
          {sandboxReady && (
            <>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>Account code (optional)
                <input data-testid="cloud-billing-test-ref" style={S.input} value={testRef} onChange={(e) => setTestRef(e.target.value)} placeholder="e.g. ACME" /></label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>Amount (KES)
                <input data-testid="cloud-billing-test-amount" style={{ ...S.input, width: 90 }} inputMode="numeric" value={testAmount} onChange={(e) => setTestAmount(e.target.value)} /></label>
              <button data-testid="cloud-billing-test" disabled={busy} onClick={() => run(() => req("POST", "/cloud-billing/test-payment", { amount: Number(testAmount) || 1, bill_ref: testRef.trim() || null }), (v) => `Sandbox test payment sent (${kes(v.amount)}${v.bill_ref ? `, account ${v.bill_ref}` : ""}). It should appear below in a few seconds — Refresh.`)}
                style={{ ...S.btn, ...S.btnGhost, opacity: busy ? 0.5 : 1 }}>Send sandbox test payment</button>
            </>
          )}
        </div>
      ) : <div style={{ fontSize: 11, color: C.muted }}>Super admin registers and tests the Paybill.</div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "18px 0 8px" }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>Receipts</div>
        <button data-testid="cloud-billing-refresh" onClick={loadReceipts} style={{ ...S.btn, ...S.btnGhost, fontSize: 11 }}>Refresh</button>
      </div>
      {receipts.length === 0 ? <div style={{ fontSize: 12, color: C.muted }}>No payments received yet.</div> : (
        <div className="sp-table-wrap"><table style={S.table} data-testid="cloud-billing-receipts">
          <thead><tr>{["Received", "Amount", "Account", "Client", "M-Pesa code"].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>{receipts.map((r) => (
            <tr key={r.id}>
              <td style={{ ...S.td, fontSize: 12 }}>{when(r.created_at)}</td>
              <td style={{ ...S.td, fontFamily: "monospace" }}>{kes(r.amount)}</td>
              <td style={{ ...S.td, fontSize: 12 }}>{r.bill_ref ?? "—"}</td>
              <td style={{ ...S.td, fontSize: 12 }}>
                {r.status === "reversed"
                  ? <span style={{ color: C.muted }}>{r.business_name ?? "—"} <span style={{ color: "#f87171" }}>(reversed)</span></span>
                  : r.business_name
                  ? <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ color: "#34e5a0" }}>{r.business_name}</span>
                      {isSuper && <button data-testid={`receipt-reverse-${r.id}`} disabled={busy} onClick={() => reverse(r)}
                        style={{ ...S.btn, ...S.btnGhost, fontSize: 11, opacity: busy ? 0.5 : 1 }}>Reverse</button>}
                    </span>
                  : <span data-testid={`receipt-unmatched-${r.id}`} style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ color: "#f59e0b" }}>unmatched</span>
                      {isSuper && <>
                        <input style={{ ...S.input, width: 120, fontSize: 11 }} placeholder="correct code" value={assignDraft[r.id] ?? ""} onChange={(e) => setAssignDraft({ ...assignDraft, [r.id]: e.target.value })} />
                        <button disabled={busy || !(assignDraft[r.id] ?? "").trim()} onClick={() => run(() => req("POST", `/cloud-billing/receipts/${r.id}/assign`, { code: assignDraft[r.id] ?? "" }), () => "Payment assigned to the client.")}
                          style={{ ...S.btn, ...S.btnGhost, fontSize: 11, opacity: busy || !(assignDraft[r.id] ?? "").trim() ? 0.5 : 1 }}>Assign</button>
                      </>}
                    </span>}
              </td>
              <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{r.trans_id}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <div style={{ fontSize: 11, color: C.muted, marginTop: 12 }}>
        Phase 1 — the pipe: a payment lands here raw. Matching the account code to a client, the credit wallet and auto-allocation are Phase 2 (docs/tasks/A626).
      </div>
    </div>
  );
}
