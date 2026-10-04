/**
 * AlertsPage — A392: everything the cloud's watchdog found, in the admin portal.
 *
 * Owner, 2026-10-04: "include alerts in the admin portal — all alerts emails should only get critical failures like
 * continuous failed login attempts, failed sync due to misconfigs, critical alerts only; others put in the admin".
 *
 * Open problems (critical first, then warnings), the last 14 days' resolved ones, what the cloud saw recently that is not
 * an alert yet (refused sign-ins, refused till syncs), and the counters since the morning digest. A critical alert is
 * emailed when it opens and every 3 hours while it lasts — "Mute reminders" stops the reminders; it stays listed until
 * it clears.
 */
import { useState, useEffect, useCallback } from "react";
import { C, S } from "./theme";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface AlertRow {
  id: string; alert_key: string; severity: "critical" | "warning"; business_id: string | null; title: string;
  detail?: string | null; first_seen_at: string; last_seen_at?: string; last_notified_at?: string | null;
  notify_count?: number; resolved_at?: string | null; acknowledged_at?: string | null; acknowledged_by?: string | null;
}

const WHERE: Record<string, string> = { admin: "Admin portal", dashboard: "Dashboard", web_pos: "Web POS", till: "Till" };

export function ago(iso?: string | null): string {
  if (!iso) return "—";
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Open critical alerts — the number on the menu's Alerts item. Re-read every 2 minutes. */
export function useCriticalCount(req: Req, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setN(0); return; }
    let live = true;
    const load = () => req("GET", "/watchdog").then((d) => {
      if (live) setN((d?.alerts ?? []).filter((a: AlertRow) => a.severity === "critical").length);
    }).catch(() => {});
    load();
    const t = setInterval(load, 120_000);
    return () => { live = false; clearInterval(t); };
  }, [req, enabled]);
  return n;
}

function Dot({ severity }: { severity: string }) {
  return <span style={{ width: 9, height: 9, borderRadius: 5, marginTop: 5, flexShrink: 0, background: severity === "critical" ? C.danger : "#f59e0b" }} />;
}

/** The dashboard's short version: counts and the first three critical problems. */
export function AlertsSummary({ req, onOpen }: { req: Req; onOpen: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => { req("GET", "/watchdog").then(setData).catch((e) => setError(e?.message || "Couldn't load alerts.")); }, [req]);
  const alerts: AlertRow[] = data?.alerts ?? [];
  const crit = alerts.filter((a) => a.severity === "critical");
  const warn = alerts.filter((a) => a.severity !== "critical");
  return (
    <div style={{ ...S.card, marginBottom: 16 }} data-testid="alerts-summary">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Alerts</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            {error ? error : !data ? "Loading…" : !alerts.length ? "No open problems." :
              `${crit.length} critical · ${warn.length} to look at`}
          </div>
        </div>
        <button onClick={onOpen} style={{ ...S.btn, ...S.btnGhost }}>Open Alerts →</button>
      </div>
      {crit.slice(0, 3).map((a) => (
        <div key={a.id} style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: `1px solid ${C.border}`, marginTop: 8 }}>
          <Dot severity={a.severity} />
          <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{a.title}</div>
          <div style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>{ago(a.first_seen_at)}</div>
        </div>
      ))}
    </div>
  );
}

export default function AlertsPage({ req, isSuper }: { req: Req; isSuper: boolean }) {
  const [view, setView] = useState<"open" | "resolved">("open");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [testResult, setTestResult] = useState("");

  const load = useCallback(() => {
    setError("");
    req("GET", `/watchdog${view === "resolved" ? "?status=resolved" : ""}`)
      .then(setData).catch((e) => setError(e?.message || "Couldn't load alerts."));
  }, [req, view]);
  useEffect(() => { setData(null); load(); }, [load]);

  const mute = async (a: AlertRow, on: boolean) => {
    setBusy(a.id);
    try { await req("POST", `/watchdog/${a.id}/ack`, { mute: on }); load(); }
    catch (e: any) { setError(e?.message || "Could not save."); }
    finally { setBusy(""); }
  };

  const test = async () => {
    setBusy("test"); setTestResult("");
    try {
      const r = await req("POST", "/watchdog/test");
      setTestResult([
        r.channels?.email ? (r.sent?.email ? "Email ✓" : "Email ✗ (see the server log)") : "Email not set (ADMIN_ALERT_EMAIL)",
        r.channels?.telegram ? (r.sent?.telegram ? "Telegram ✓" : "Telegram ✗ (see the server log)") : "Telegram not set",
      ].join(" · "));
    } catch (e: any) { setTestResult(e?.message || "Test failed."); }
    finally { setBusy(""); }
  };

  const alerts: AlertRow[] = data?.alerts ?? [];
  const crit = alerts.filter((a) => a.severity === "critical");
  const warn = alerts.filter((a) => a.severity !== "critical");
  const ch = data?.channels;
  const recent = data?.recent ?? { signins: [], sync: [] };
  const counters = data?.counters;

  const row = (a: AlertRow) => (
    <div key={a.id} data-testid={`alert-${a.severity}`} style={{ display: "flex", gap: 12, padding: "12px 0", borderTop: `1px solid ${C.border}`, alignItems: "flex-start" }}>
      <Dot severity={a.severity} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{a.title}</div>
        {a.detail && <div style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.5 }}>{a.detail}</div>}
        <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>
          {view === "resolved"
            ? `Started ${ago(a.first_seen_at)} · resolved ${ago(a.resolved_at)}`
            : `Since ${ago(a.first_seen_at)}`}
          {a.severity === "critical" && (a.notify_count ?? 0) > 0 && ` · emailed ${a.notify_count}×`}
          {a.acknowledged_at && ` · reminders muted by ${a.acknowledged_by || "an admin"}`}
        </div>
      </div>
      {view === "open" && a.severity === "critical" && (
        <button disabled={busy === a.id} onClick={() => mute(a, !a.acknowledged_at)}
          style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "5px 10px" }}>
          {busy === a.id ? "…" : a.acknowledged_at ? "Unmute" : "Mute reminders"}
        </button>
      )}
    </div>
  );

  return (
    <div style={S.content}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Alerts</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: "4px 0 0", maxWidth: 640, lineHeight: 1.5 }}>
            The cloud checks every client every 10 minutes. Only <b style={{ color: C.text }}>critical</b> problems are
            emailed — when they start and every 3 hours while they last. Everything else is listed here.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ ...S.badge, background: "rgba(255,255,255,0.06)", color: ch?.email ? "#34e5a0" : C.muted }}>Email {ch?.email ? "on" : "off"}</span>
          <span style={{ ...S.badge, background: "rgba(255,255,255,0.06)", color: ch?.telegram ? "#34e5a0" : C.muted }}>Telegram {ch?.telegram ? "on" : "off"}</span>
          {isSuper && (
            <button onClick={test} disabled={busy === "test"} style={{ ...S.btn, ...S.btnGhost }} data-testid="watchdog-test">
              {busy === "test" ? "Sending…" : "Send test alert"}
            </button>
          )}
          <button onClick={load} style={{ ...S.btn, ...S.btnGhost }}>Refresh</button>
        </div>
      </div>
      {testResult && <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>{testResult}</div>}
      {error && <div style={{ fontSize: 13, color: C.danger, marginBottom: 12 }}>{error}</div>}

      <div className="sp-tab-bar">
        {([["open", `Open${data && view === "open" ? ` (${alerts.length})` : ""}`], ["resolved", "Resolved (14 days)"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} style={{ ...S.tab, ...(view === k ? S.tabActive : {}) }}>{l}</button>
        ))}
      </div>

      {!data && !error && <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>}

      {data && view === "open" && (
        <>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.danger }}>Critical ({crit.length})</div>
            <div style={{ fontSize: 11, color: C.muted, margin: "2px 0 6px" }}>Emailed. Sales or security are affected now.</div>
            {!crit.length && <div style={{ fontSize: 13, color: "#34e5a0", padding: "6px 0" }}>Nothing critical.</div>}
            {crit.map(row)}
          </div>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#f59e0b" }}>To look at ({warn.length})</div>
            <div style={{ fontSize: 11, color: C.muted, margin: "2px 0 6px" }}>Not emailed — shown here and in the morning digest.</div>
            {!warn.length && <div style={{ fontSize: 13, color: C.muted, padding: "6px 0" }}>Nothing to look at.</div>}
            {warn.map(row)}
          </div>
        </>
      )}

      {data && view === "resolved" && (
        <div style={S.card}>
          {!alerts.length && <div style={{ fontSize: 13, color: C.muted }}>Nothing resolved in the last 14 days.</div>}
          {alerts.map(row)}
        </div>
      )}

      {data && (
        <div className="sp-two-col" style={{ alignItems: "start" }}>
          <div style={S.card} data-testid="recent-signins">
            <div style={{ fontSize: 13, fontWeight: 600 }}>Refused sign-ins — last 30 min</div>
            <div style={{ fontSize: 11, color: C.muted, margin: "2px 0 8px" }}>
              Becomes critical at 8 on one account (5 on an admin account) or 20 from one address in 15 min.
            </div>
            {!recent.signins.length && <div style={{ fontSize: 12, color: C.muted }}>None.</div>}
            {recent.signins.slice(0, 15).map((f: any, i: number) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 12, padding: "6px 0", borderTop: `1px solid ${C.border}` }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{f.account || "—"}</span>
                <span style={{ color: C.muted }}>{WHERE[f.where] ?? f.where}</span>
                <span style={{ color: C.muted, fontFamily: "monospace" }}>{f.ip}</span>
                <span style={{ color: C.muted, whiteSpace: "nowrap" }}>{ago(f.at)}</span>
              </div>
            ))}
          </div>
          <div style={S.card} data-testid="recent-sync">
            <div style={{ fontSize: 13, fontWeight: 600 }}>Tills the cloud refused — last 3 hours</div>
            <div style={{ fontSize: 11, color: C.muted, margin: "2px 0 8px" }}>
              Becomes critical when a till is refused 3 times in 30 min with nothing taken, or a record is refused.
            </div>
            {!recent.sync.length && <div style={{ fontSize: 12, color: C.muted }}>None.</div>}
            {recent.sync.map((s: any) => (
              <div key={s.device_id} style={{ fontSize: 12, padding: "7px 0", borderTop: `1px solid ${C.border}` }}>
                <div><b>{String(s.device_id).slice(0, 8)}</b> · refused {s.refused}× · HTTP {s.status}{s.code ? ` ${s.code}` : ""} · {ago(s.last_at)}</div>
                {s.error && <div style={{ color: C.muted, marginTop: 2 }}>{s.error}</div>}
                <div style={{ color: C.muted, marginTop: 2 }}>{s.hint}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {counters && (
        <div style={{ fontSize: 12, color: C.muted }}>
          Since {String(counters.since).slice(0, 16).replace("T", " ")} UTC: {counters.serverErrors} server errors ·{" "}
          {counters.failedSignIns} refused sign-ins · {counters.writeGuard} till writes the cloud would block.
        </div>
      )}
    </div>
  );
}
