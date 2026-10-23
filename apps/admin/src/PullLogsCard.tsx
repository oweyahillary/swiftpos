/**
 * PullLogs — A533: "Pull logs" in the Support logs card (client page › Desktop updates).
 *
 * Owner, 2026-10-19: "add a feature where we can pull local logs of a server or a till to cloud so that we can be
 * investigating such issues" — and, on this tab: "how do I pull logs".
 *
 * Choose a till or the branch server (label, version, last seen), how far back (24 hours, 3 days, 7 days), whether to
 * include the sign-in history, and why → Request. The till hears it within a minute or two (the push channel, or its
 * 90 s beat) and sends the log the same way as "Send logs to support" on its Tech page (secrets removed). The list shows
 * each request: waiting (with when the till was last seen; Cancel), delivered (View / Download the log, as below),
 * expired (7 days unanswered), cancelled. A till older than 1.0.20 cannot answer — it says so.
 * A554 (the owner's screenshot, 2026-10-21): the version warning showed twice (orange under the device, then green as
 * the request's notice) — now once, in the warning colour; the cloud warns only when nothing says the device answers
 * (it reports log_pull, or answered a pull before — not its version alone), "may wait"; and the device list shows each
 * version in full (it came second, after the name, and the list is wider — "Mama Ngina · v1.0" was cut).
 * Cloud: /api/admin/clients/:id/log-requests (routes/logRequestsAdmin.ts) — any admin; audited.
 */
import { useEffect, useRef, useState } from "react";
import { C, S } from "./theme";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface Device { device_id: string; label: string; terminal_code: string | null; role: string; branch: string | null;
  app_version: string | null; last_seen_at: string | null; can_answer: boolean; note: string | null }
interface PullRow { id: string; device_id: string; device_label: string; terminal_code: string | null; app_version: string | null;
  last_seen_at: string | null; requested_at: string; requested_by_email: string | null; reason: string; range_hours: number;
  include: { auth?: boolean } | null; status: "waiting" | "delivered" | "expired" | "cancelled"; delivered_at: string | null;
  note: string | null; support_log: { id: string; reference: string } | null }

const RANGES: Array<[number, string]> = [[24, "24 hours"], [72, "3 days"], [168, "7 days"]];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" }) : "—");
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" }) : "never");
const rangeLabel = (h: number) => RANGES.find(([n]) => n === h)?.[1] ?? `${h} h`;
const roleLabel = (r: string) => (r === "node" ? "branch server" : r === "office" ? "office PC" : "till");
const WARN = "#f59e0b";
/**
 * A554: one device in the list — the version straight after the name, so a narrow list never cuts it ("Mama Ngina ·
 * v1.0" in the owner's screenshot), then the role, the branch and when it was last seen.
 */
function deviceOption(d: Device): string {
  const code = d.terminal_code && d.terminal_code !== d.label ? ` (${d.terminal_code})` : "";
  return `${d.label}${code} · ${d.app_version ? `v${d.app_version}` : "version ?"} · ${roleLabel(d.role)}${d.branch ? ` · ${d.branch}` : ""} · seen ${time(d.last_seen_at)}`;
}
const STATUS: Record<PullRow["status"], { label: string; color: string }> = {
  waiting: { label: "Waiting", color: WARN }, delivered: { label: "Delivered", color: C.green },
  expired: { label: "Expired", color: C.muted }, cancelled: { label: "Cancelled", color: C.muted },
};

export default function PullLogs({ clientId, req, onView, onDownload, onDelivered }: {
  clientId: string; req: Req; onView: (logId: string) => void; onDownload: (logId: string) => void; onDelivered: () => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [rows, setRows] = useState<PullRow[] | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [range, setRange] = useState(24);
  const [auth, setAuth] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);   // A554: a warning is shown as one
  const [busy, setBusy] = useState(false);
  const delivered = useRef<Set<string> | null>(null);

  const base = `/clients/${encodeURIComponent(clientId)}/log-requests`;
  const load = async (quiet = false) => {
    if (!quiet) setError("");
    try {
      const d = await req("GET", base);
      const list: PullRow[] = Array.isArray(d?.requests) ? d.requests : [];
      setRows(list);
      setDevices(Array.isArray(d?.devices) ? d.devices : []);
      // A request answered since the last look: the logs list below shows the new log too.
      const now = list.filter((r) => r.status === "delivered").map((r) => r.id);
      if (delivered.current && now.some((id) => !delivered.current!.has(id))) onDelivered();
      delivered.current = new Set(now);
    } catch (e: any) { if (!quiet) setError(e?.message ?? "Could not load the log requests."); }
  };
  useEffect(() => { delivered.current = null; void load(); }, [clientId]);   // eslint-disable-line react-hooks/exhaustive-deps
  // While a request waits, look again every 15 s (this page only) — the till answers within a minute or two.
  const anyWaiting = !!rows?.some((r) => r.status === "waiting");
  useEffect(() => {
    if (!anyWaiting) return;
    const t = setInterval(() => { void load(true); }, 15_000);
    return () => clearInterval(t);
  }, [anyWaiting, clientId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = devices.find((d) => d.device_id === deviceId) ?? null;
  const request = async () => {
    setBusy(true); setError(""); setNotice(null);
    try {
      const d = await req("POST", base, { device_id: deviceId, reason, range_hours: range, include: { auth } });
      setReason("");
      setNotice(d?.note ? { text: d.note, warn: true }
        : { text: `Asked ${d?.request?.device_label ?? "the till"} — it answers within a minute or two when it is on and online.`, warn: false });
      await load(true);
    } catch (e: any) { setError(e?.message ?? "Could not ask for the log."); }
    finally { setBusy(false); }
  };
  const cancel = async (r: PullRow) => {
    setBusy(true); setError("");
    try { await req("POST", `${base}/${r.id}/cancel`, { reason: "cancelled in the admin portal" }); await load(true); }
    catch (e: any) { setError(e?.message ?? "Could not cancel that request."); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 4, marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }} data-testid="pull-logs">
      <div style={{ fontSize: 13, fontWeight: 600 }}>Pull logs</div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Ask a till or the branch server to send its log — no one at the shop needs to press anything. Secrets are removed on the till.</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
        <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); setNotice(null); }} style={{ ...S.input, flex: "1 1 380px", minWidth: 240, maxWidth: "100%" }} data-testid="pull-device">
          <option value="">Choose a till or server…</option>
          {devices.map((d) => (
            <option key={d.device_id} value={d.device_id}>
              {deviceOption(d)}
            </option>
          ))}
        </select>
        <select value={range} onChange={(e) => setRange(Number(e.target.value))} style={{ ...S.input, maxWidth: 130 }} data-testid="pull-range">
          {RANGES.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
        </select>
        <label style={{ fontSize: 12, color: C.muted, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={auth} onChange={(e) => setAuth(e.target.checked)} data-testid="pull-auth" /> Include sign-in history
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (kept with the request and in the admin log)" maxLength={300}
          style={{ ...S.input, flex: 1, minWidth: 220 }} data-testid="pull-reason" />
        <button disabled={busy || !deviceId || !reason.trim()} onClick={request} style={{ ...S.btn, ...S.btnPrimary, fontSize: 12 }} data-testid="pull-request">Request</button>
      </div>
      {(() => {
        // A554: one warning, in the warning colour — the device's note, or the request's (the same words) once asked.
        const warning = notice?.warn ? notice.text : chosen && !chosen.can_answer && chosen.note ? chosen.note : null;
        return (
          <>
            {warning && <div style={{ fontSize: 12, color: WARN, marginTop: 8 }} data-testid="pull-warning">{warning}</div>}
            {notice && !notice.warn && <div style={{ fontSize: 12, color: C.green, marginTop: 8 }} data-testid="pull-notice">{notice.text}</div>}
          </>
        );
      })()}
      {error && <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>{error}</div>}
      {rows && rows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, padding: "6px 0", borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
              <span style={{ ...S.badge, color: STATUS[r.status].color, border: `1px solid ${STATUS[r.status].color}` }}>{STATUS[r.status].label}</span>
              <span style={{ flex: 1, minWidth: 200 }}>
                {r.device_label} <span style={{ color: C.muted }}>· {rangeLabel(r.range_hours)}{r.include?.auth ? " + sign-in history" : ""} · {r.reason} · {r.requested_by_email ?? "—"} · {when(r.requested_at)}</span>
                {r.status === "waiting" && <div style={{ color: C.muted, marginTop: 2 }}>Till last seen {time(r.last_seen_at)}{r.note ? ` — ${r.note}` : ""}</div>}
              </span>
              {r.status === "delivered" && r.support_log && (
                <>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: C.accent }}>{r.support_log.reference}</span>
                  <button onClick={() => onView(r.support_log!.id)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" }}>View</button>
                  <button onClick={() => onDownload(r.support_log!.id)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" }}>Download</button>
                </>
              )}
              {r.status === "waiting" && <button disabled={busy} onClick={() => cancel(r)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" }}>Cancel</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
