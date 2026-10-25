/**
 * SupportLogsCard — A519: the logs this client's tills sent to support (Tech page › "Send logs to support").
 *
 * The client reads a reference out on the phone ("K7Q2XM"); it is found here, or in the client's list (newest first):
 * which till, which version, who sent it, how big, when. "View" shows the log (the last 24 hours of the till's log,
 * every secret removed on the till and again by the cloud); "Download" saves it as a .txt. Read only, any admin.
 * Cloud: GET /api/admin/support-logs (routes/supportAdmin.ts).
 */
import { useEffect, useState } from "react";
import { C, S } from "./theme";
import PullLogs from "./PullLogsCard";   // A533: pull a till's or a branch server's log from here

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface LogRow {
  id: string; reference: string; terminal_code: string | null; device_id: string; app_version: string | null;
  sent_by: string | null; bytes: number; trimmed: boolean; created_at: string;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
const kb = (n: number) => `${Math.max(1, Math.round((n || 0) / 1024))} kB`;

export default function SupportLogsCard({ clientId, req }: { clientId: string; req: Req }) {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [ref, setRef] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<{ row: LogRow; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (reference?: string) => {
    setBusy(true); setError("");
    try {
      const q = reference ? `reference=${encodeURIComponent(reference.trim().toUpperCase())}` : `business=${encodeURIComponent(clientId)}`;
      const d = await req("GET", `/support-logs?${q}`);
      setRows(Array.isArray(d?.logs) ? d.logs : []);
    } catch (e: any) { setError(e?.message ?? "Could not load the support logs."); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [clientId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const view = async (row: LogRow) => {
    setBusy(true); setError("");
    try { const d = await req("GET", `/support-logs/${row.id}`); setOpen({ row, text: String(d?.text ?? "") }); }
    catch (e: any) { setError(e?.message ?? "Could not open that log."); }
    finally { setBusy(false); }
  };
  // A533: a pulled log opens and downloads as any other (by its id, from the Pull logs list).
  const viewById = async (id: string) => {
    setBusy(true); setError("");
    try { const d = await req("GET", `/support-logs/${id}`); setOpen({ row: d as LogRow, text: String(d?.text ?? "") }); }
    catch (e: any) { setError(e?.message ?? "Could not open that log."); }
    finally { setBusy(false); }
  };
  const downloadById = async (id: string) => {
    try { const d = await req("GET", `/support-logs/${id}`); await download(d as LogRow, String(d?.text ?? "")); }
    catch (e: any) { setError(e?.message ?? "Could not download that log."); }
  };
  const download = async (row: LogRow, known?: string) => {
    try {
      const d = known !== undefined ? { text: known } : open?.row.id === row.id ? { text: open.text } : await req("GET", `/support-logs/${row.id}`);
      const url = URL.createObjectURL(new Blob([String(d?.text ?? "")], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url; a.download = `zaptill-${row.terminal_code ?? "till"}-${row.reference}.txt`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { setError(e?.message ?? "Could not download that log."); }
  };

  return (
    <div style={S.card} data-testid="support-logs-card">
      <PullLogs clientId={clientId} req={req} onView={viewById} onDownload={downloadById} onDelivered={() => { void load(); }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Support logs</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Sent from a POS's Tech page (the last 24 hours, secrets removed — the client reads out the reference), or pulled above.</div>
        </div>
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Reference, e.g. K7Q2XM" maxLength={8}
          style={{ ...S.input, maxWidth: 190, textTransform: "uppercase" }} data-testid="support-log-ref" />
        <button disabled={busy || !ref.trim()} onClick={() => load(ref)} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>Find</button>
        <button disabled={busy} onClick={() => { setRef(""); void load(); }} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>All</button>
      </div>
      {error && <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>{error}</div>}
      {rows && rows.length === 0 && <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>No logs sent{ref.trim() ? " with that reference" : ""}.</div>}
      {rows && rows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, padding: "6px 0", borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "monospace", fontWeight: 700, color: C.accent }}>{r.reference}</span>
              <span style={{ flex: 1, minWidth: 180 }}>{r.terminal_code ?? "a POS"} <span style={{ color: C.muted }}>· {r.app_version ? `v${r.app_version}` : "—"} · {r.sent_by ?? "—"} · {kb(r.bytes)}{r.trimmed ? " (older lines left out)" : ""}</span></span>
              <span style={{ color: C.muted }}>{when(r.created_at)}</span>
              <button onClick={() => view(r)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" }}>View</button>
              <button onClick={() => download(r)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" }}>Download</button>
            </div>
          ))}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 4 }}>
            <span>{open.row.reference} · {open.row.terminal_code ?? "a POS"} · {when(open.row.created_at)}</span>
            <button onClick={() => setOpen(null)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "2px 8px" }}>Close</button>
          </div>
          <pre style={{ maxHeight: 420, overflow: "auto", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", background: "rgba(0,0,0,0.35)", border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, color: C.text }}>{open.text}</pre>
        </div>
      )}
    </div>
  );
}
