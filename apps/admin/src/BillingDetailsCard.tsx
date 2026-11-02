/**
 * BillingDetailsCard — A612 phase 3: ZapTill's own billing details and monthly prices, on the admin portal's Billing page.
 *
 * Owner, 2026-10-30: "You can use dummy information … but in the admin panel we can add the true ones later". Every client
 * invoice prints these (the company, its KRA PIN, the M-Pesa Paybill or Till and the account reference); until they are
 * saved the invoice prints the sample, marked "Sample details". The prices are a month each (Cloud, Analytics,
 * Attendance, Themes, the Premium package). Cloud: GET / PUT /api/admin/billing-details (routes/billingDetailsAdmin.ts).
 */
import { useEffect, useState } from "react";
import { C, S } from "./theme";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;
interface Seller { legalName: string; address: string; kraPin: string | null; phone: string; email: string | null; mpesaPaybill: string | null; mpesaTill: string | null; accountRef: "invoice" | "business" }
interface Prices { cloud: number; analytics: number; attendance: number; themes: number; package: number }

const PRICE_FIELDS: Array<[keyof Prices, string]> = [["cloud", "Cloud"], ["analytics", "Analytics"], ["attendance", "Attendance"], ["themes", "Themes"], ["package", "Premium package"]];

export default function BillingDetailsCard({ req, isSuper }: { req: Req; isSuper: boolean }) {
  const [seller, setSeller] = useState<Seller | null>(null);
  const [prices, setPrices] = useState<Record<keyof Prices, string> | null>(null);
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const adopt = (v: { seller: Seller; prices: Prices; saved: boolean }) => {
    setSeller(v.seller); setSaved(v.saved);
    setPrices(Object.fromEntries(PRICE_FIELDS.map(([k]) => [k, String(v.prices[k])])) as Record<keyof Prices, string>);
  };
  useEffect(() => { req("GET", "/billing-details").then(adopt).catch((e) => setMsg({ ok: false, text: e.message })); }, [req]);
  if (!seller || !prices) return <div style={S.card}><div style={{ fontSize: 12, color: C.muted }}>{msg?.text ?? "Loading the billing details…"}</div></div>;
  const field = (title: string, el: React.ReactNode) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted, minWidth: 160, flex: 1 }}>{title}{el}</label>
  );
  const text = (k: keyof Seller, title: string, placeholder = "") => field(title,
    <input disabled={!isSuper} style={S.input} placeholder={placeholder} value={(seller[k] as string | null) ?? ""} onChange={(e) => setSeller({ ...seller, [k]: e.target.value })} />);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      adopt(await req("PUT", "/billing-details", { seller, prices: Object.fromEntries(PRICE_FIELDS.map(([k]) => [k, Number(prices[k])])) }));
      setMsg({ ok: true, text: "Billing details saved — the next invoices print them." });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <div style={S.card} data-testid="billing-details">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Billing details (on every client invoice)</div>
        {!saved && <div style={{ fontSize: 11, color: "#f59e0b" }}>Not saved yet — invoices print sample details</div>}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
        {text("legalName", "Company name", "ZapTill Limited")}
        {text("address", "Address", "P.O. Box …, Nairobi")}
        {text("kraPin", "KRA PIN", "P0…")}
        {text("phone", "Phone")}
        {text("email", "Email (optional)")}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "flex-end" }}>
        {text("mpesaPaybill", "M-Pesa Paybill", "business number")}
        {text("mpesaTill", "or Buy Goods Till number", "if no Paybill")}
        {field("Paybill account", <select disabled={!isSuper} style={S.input} value={seller.accountRef} onChange={(e) => setSeller({ ...seller, accountRef: e.target.value as Seller["accountRef"] })}>
          <option value="invoice">The invoice number</option>
          <option value="business">The client's code</option>
        </select>)}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, margin: "16px 0 8px" }}>Prices, a branch a month (KES)</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {PRICE_FIELDS.map(([k, n]) => field(n, <input key={k} disabled={!isSuper} style={S.input} inputMode="numeric" value={prices[k]} onChange={(e) => setPrices({ ...prices, [k]: e.target.value })} />))}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>A branch on the Premium package pays its price in place of the Cloud and the premium items. Longer periods are the monthly price times the months.</div>
      {msg && <div style={{ fontSize: 12, color: msg.ok ? "#34e5a0" : C.danger, marginTop: 8 }}>{msg.text}</div>}
      <div style={{ marginTop: 10 }}>
        {isSuper
          ? <button data-testid="billing-details-save" disabled={busy} onClick={save} style={{ ...S.btn, ...S.btnPrimary, opacity: busy ? 0.5 : 1 }}>Save billing details</button>
          : <span style={{ fontSize: 11, color: C.muted }}>Super admin only</span>}
      </div>
    </div>
  );
}
