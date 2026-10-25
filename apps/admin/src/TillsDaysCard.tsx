/**
 * TillsDaysCard — A523: "Tills & days" on a client's page — support closes a till's day or drawer for the client.
 *
 * Owner, 2026-10-17: "there is no location on the cloud where I can close day as the owner or tech support remote force
 * close" — "super admins and agents" may rescue. Every till of the client (every branch): its version, last sync, open
 * trading day, open drawers (cashier, since, float, expected so far), shifts waiting for a manager, closes waiting for it.
 * Actions — Close day (on the web at once; the till adopts it), Force-close / Close with count, Withdraw a stuck close,
 * Close as abandoned — each with a REQUIRED reason and the silent-till tick. Every action is in the admin audit log and the
 * client's audit log, the owner is e-mailed, and the super admins are asked to verify an agent's action.
 * Cloud: /api/admin/tills-days/:businessId/… (routes/tillsDaysAdmin.ts).
 */
import { useEffect, useState } from "react";
import { C, S } from "./theme";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface Drawer { id: string; cashier_name: string; opened_at: string; opening_float: number; expected_cash: number | null }
interface Waiting { id: string; business_date: string; created_at: string; delivered_at: string | null; waiting: boolean; code: string | null; error: string | null; cloud_closed: boolean; reason: string | null }
interface Till {
  device_id: string; label: string; branch_name: string | null; app_version: string | null; last_sync_at: string | null;
  silent: boolean; long_silent: boolean; retired: boolean; on_fleet: boolean; may_abandon: boolean;
  open_days: Array<{ id: string; business_date: string; opened_at: string | null }>;
  open_drawers: Drawer[]; awaiting: Array<{ id: string; cashier_name: string; closed_at: string | null }>; pending: Waiting[];
}
type Action =
  | { kind: "close_day"; till: Till; date: string }
  | { kind: "drawer"; till: Till; drawer: Drawer; counted: boolean }
  | { kind: "cancel"; till: Till; waiting: Waiting }
  | { kind: "abandon"; till: Till; date: string };

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" }) : "—");
const ago = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "never";
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 2880 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};
const kes = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `KES ${Number(n).toLocaleString("en-KE")}`);

export default function TillsDaysCard({ clientId, req }: { clientId: string; req: Req }) {
  const [tills, setTills] = useState<Till[] | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [act, setAct] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [count, setCount] = useState("");
  const [silentOk, setSilentOk] = useState(false);
  const [forceOk, setForceOk] = useState(false);
  const [abandonOk, setAbandonOk] = useState(false);
  const [askForce, setAskForce] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/tills-days/${encodeURIComponent(clientId)}`;

  const load = async () => {
    try { const d = await req("GET", `${base}/overview`); setTills(Array.isArray(d?.tills) ? d.tills : []); setError(""); }
    catch (e: any) { setError(e?.message ?? "Could not load the client's points of sale."); }
  };
  useEffect(() => { void load(); }, [clientId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const open = (a: Action) => {
    setAct(a); setReason(""); setCount(""); setSilentOk(false); setForceOk(false); setAbandonOk(false); setMsg("");
    setAskForce(a.kind === "close_day" && a.till.open_drawers.length > 0);
  };

  const submit = async () => {
    if (!act) return;
    if (!reason.trim()) { setMsg("A reason is required — the owner is e-mailed it."); return; }
    const typed = count.trim();
    const amount = typed === "" ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) { setMsg("The count must be 0 or more — or leave it empty."); return; }
    if (act.kind === "drawer" && act.counted && amount === null) { setMsg("Enter the cash counted in the drawer."); return; }
    if (act.kind === "abandon" && !abandonOk) { setMsg("Tick that the POS's unsent sales are not in this close."); return; }
    setBusy(true); setMsg("");
    try {
      let r: any;
      if (act.kind === "close_day") r = await req("POST", `${base}/close-day`, { device_id: act.till.device_id, business_date: act.date, counted_cash: amount, reason: reason.trim(), silent_ok: silentOk, force_drawers: forceOk });
      else if (act.kind === "drawer") r = await req("POST", `${base}/close-drawer`, { shift_id: act.drawer.id, counted_cash: act.counted ? amount : null, reason: reason.trim(), silent_ok: silentOk });
      else if (act.kind === "cancel") r = await req("POST", `${base}/instructions/${encodeURIComponent(act.waiting.id)}/cancel`, { reason: reason.trim() });
      else r = await req("POST", `${base}/abandon`, { device_id: act.till.device_id, business_date: act.date, reason: reason.trim(), confirm: true });
      setDone(`Done — ${act.till.label}. ${r?.owner_emailed ? "The owner was e-mailed." : "The owner could not be e-mailed (no address, or the mail failed) — it is in their notifications."}`);
      setAct(null);
      await load();
    } catch (e: any) {
      if (e?.code === "DRAWER_OPEN") { setAskForce(true); setMsg(e?.message ?? "A drawer is still open."); }
      else setMsg(e?.message ?? "That did not go through.");
    } finally { setBusy(false); }
  };

  const small = { ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" };
  const danger = { ...S.btn, ...S.btnDanger, fontSize: 11, padding: "4px 10px" };
  const row = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" as const, fontSize: 12, padding: "6px 0", borderTop: `1px solid ${C.border}` };

  return (
    <div style={S.card} data-testid="tills-days-card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Tills &amp; days</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Close a POS's day or a drawer for the client. It takes effect on the cloud at once; the POS adopts it when it next connects. A reason is required; the owner is e-mailed and it is audited.</div>
        </div>
        <button onClick={() => void load()} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>Reload</button>
      </div>
      {error && <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>{error}</div>}
      {done && <div style={{ fontSize: 12, color: C.green, marginTop: 8 }}>{done}</div>}
      {tills && tills.length === 0 && <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>No points of sale.</div>}
      {(tills ?? []).map((t) => (
        <div key={t.device_id} style={{ marginTop: 12 }} data-testid={`admin-till-${t.device_id}`}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {t.label} <span style={{ color: C.muted, fontWeight: 400 }}>· {t.branch_name ?? "no branch"} · {t.app_version ? `v${t.app_version}` : "—"} · </span>
            <span style={{ color: t.silent ? "#f59e0b" : C.muted, fontWeight: 400 }}>last synced {ago(t.last_sync_at)}</span>
            {t.retired && <span style={{ color: C.danger, fontWeight: 400 }}> · retired</span>}
            {!t.retired && t.long_silent && <span style={{ color: C.danger, fontWeight: 400 }}> · silent over 24 h</span>}
          </div>
          {t.open_days.length === 0 && t.open_drawers.length === 0 && <div style={{ ...row, color: C.muted }}>No open trading day.</div>}
          {t.open_days.map((d) => (
            <div key={d.id} style={row}>
              <span style={{ flex: 1 }}>Day <b>{d.business_date}</b> open since {when(d.opened_at)}</span>
              {!t.retired && !t.pending.some((w) => w.cloud_closed && w.business_date === d.business_date) && <button style={small} onClick={() => open({ kind: "close_day", till: t, date: d.business_date })}>Close day</button>}
              {t.may_abandon && <button style={danger} onClick={() => open({ kind: "abandon", till: t, date: d.business_date })}>Close as abandoned</button>}
            </div>
          ))}
          {t.open_drawers.map((s) => (
            <div key={s.id} style={row}>
              <span style={{ flex: 1 }}>Drawer open — <b>{s.cashier_name}</b> since {when(s.opened_at)} · float {kes(s.opening_float)} · expected so far {kes(s.expected_cash)}</span>
              <button style={small} onClick={() => open({ kind: "drawer", till: t, drawer: s, counted: true })}>Close with count</button>
              <button style={danger} onClick={() => open({ kind: "drawer", till: t, drawer: s, counted: false })}>Force-close</button>
            </div>
          ))}
          {t.awaiting.length > 0 && <div style={{ ...row, color: "#fbbf24" }}>Waiting for a manager's confirmation: {t.awaiting.map((a) => a.cashier_name).join(", ")} — the client confirms them (Open drawers) before the day closes.</div>}
          {t.pending.map((w) => (
            <div key={w.id} style={row}>
              <span style={{ flex: 1, color: w.waiting ? "#fbbf24" : C.muted }}>
                {w.cloud_closed ? `Day ${w.business_date} closed on the cloud — the POS adopts it when it connects.`
                  : w.waiting ? `Close of ${w.business_date} waiting — ${w.code === "DRAWER_OPEN" ? "a drawer is open on the POS" : w.code === "SHIFTS_UNCONFIRMED" ? "a shift waits for confirmation" : (w.error ?? "the POS cannot close yet")}.`
                  : `Close of ${w.business_date} queued ${ago(w.created_at)}${w.delivered_at ? " — collected" : ""}.`}
                {w.reason ? ` Reason: ${w.reason}.` : ""}
              </span>
              {!w.cloud_closed && <button style={small} onClick={() => open({ kind: "cancel", till: t, waiting: w })}>Withdraw</button>}
            </div>
          ))}
        </div>
      ))}

      {act && (
        <div style={{ marginTop: 14, padding: 14, border: `1px solid ${C.border}`, borderRadius: 12, background: "rgba(0,0,0,0.25)" }} data-testid="tills-days-dialog">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {act.kind === "close_day" && `Close ${act.till.label} — day ${act.date}`}
            {act.kind === "drawer" && `${act.counted ? "Close with a count" : "Force-close (uncounted)"}: ${act.drawer.cashier_name}'s drawer on ${act.till.label}`}
            {act.kind === "cancel" && `Withdraw the close of ${act.waiting.business_date} on ${act.till.label}`}
            {act.kind === "abandon" && `Close ${act.till.label} — day ${act.date} — as abandoned (drawers force-closed uncounted)`}
          </div>
          {(act.kind === "close_day" || (act.kind === "drawer" && act.counted)) && (
            <>
              <label style={S.label}>Cash counted (KES){act.kind === "close_day" ? " — empty = the confirmed shift counts" : ""}</label>
              <input style={{ ...S.input, maxWidth: 220, marginBottom: 8 }} type="number" min="0" step="any" value={count} onChange={(e) => setCount(e.target.value)} />
            </>
          )}
          <label style={S.label}>Reason (required — the owner is e-mailed it)</label>
          <textarea style={{ ...S.input, minHeight: 54 }} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. client called — T2 locked on yesterday's day" />
          {act.till.silent && act.kind !== "cancel" && act.kind !== "abandon" && (
            <label style={{ display: "flex", gap: 8, fontSize: 12, color: "#fbbf24", marginTop: 8 }}>
              <input type="checkbox" checked={silentOk} onChange={(e) => setSilentOk(e.target.checked)} />
              <span>{act.till.label} last synced {ago(act.till.last_sync_at)} — its sales since then are not on the cloud yet; it applies this when it next connects.</span>
            </label>
          )}
          {act.kind === "close_day" && askForce && (
            <label style={{ display: "flex", gap: 8, fontSize: 12, color: C.danger, marginTop: 8 }}>
              <input type="checkbox" checked={forceOk} onChange={(e) => setForceOk(e.target.checked)} />
              <span>Force-close the open drawer(s) first ({act.till.open_drawers.map((d) => d.cashier_name).join(", ") || "on the POS"}) — recorded uncounted.</span>
            </label>
          )}
          {act.kind === "abandon" && (
            <label style={{ display: "flex", gap: 8, fontSize: 12, color: "#fbbf24", marginTop: 8 }}>
              <input type="checkbox" checked={abandonOk} onChange={(e) => setAbandonOk(e.target.checked)} />
              <span>The POS's unsent sales are not in this close.</span>
            </label>
          )}
          {msg && <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>{msg}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={{ ...S.btn, ...S.btnGhost }} disabled={busy} onClick={() => setAct(null)}>Cancel</button>
            <button style={{ ...S.btn, ...S.btnPrimary }} disabled={busy || !reason.trim()} onClick={() => void submit()} data-testid="tills-days-submit">{busy ? "Working…" : "Go ahead"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
