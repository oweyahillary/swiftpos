/**
 * NotificationBell — A589: the admin portal's bell, in the top bar.
 *
 * Owner, 2026-10-25: "till not closed should not come as an email for each client; let it be a notification on the admin
 * portal". The client problems the watchdog opens (a day not closed, a POS not syncing …) and ZapTill's billing notices
 * (an invoice issued, unpaid day 5, locked …) land here instead of one email each (public.admin_notifications, migration
 * 174; GET /api/admin/notifications). The number is the unread ones, re-read every 2 minutes; "Mark all read" clears it.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { C, S } from "./theme";
import { ago } from "./AlertsPage";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface Notice {
  id: string; category: string; business_id: string | null; title: string; detail?: string | null;
  data?: Record<string, any> | null; created_at: string; read_at?: string | null;
}

const CATEGORY_WORD: Record<string, string> = {
  billing: "Billing", day_not_closed: "Day not closed", pos_not_syncing: "POS not syncing", pos_signed_out: "POS signed out",
  pos_refused: "POS refused", mpesa: "M-Pesa", etims: "eTIMS", pos_updates: "Updates", backup: "Backup", deploy: "Deploy",
  server_errors: "Server", overload: "Server", database: "Database", signin_attack: "Sign-ins", other_system: "Cloud",
};

/** The unread count — re-read every 2 minutes (and after "mark read"). */
export function useUnreadNotifications(req: Req, enabled: boolean): { unread: number; reload: () => void } {
  const [unread, setUnread] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) { setUnread(0); return; }
    let live = true;
    const load = () => req("GET", "/notifications?unread=1&limit=1").then((d) => { if (live) setUnread(Number(d?.unread ?? 0)); }).catch(() => {});
    load();
    const t = setInterval(load, 120_000);
    return () => { live = false; clearInterval(t); };
  }, [req, enabled, tick]);
  return { unread, reload: () => setTick((n) => n + 1) };
}

export default function NotificationBell({ req, enabled, onOpenAlerts }: { req: Req; enabled: boolean; onOpenAlerts: () => void }) {
  const { unread, reload } = useUnreadNotifications(req, enabled);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setError("");
    req("GET", "/notifications?limit=30").then((d) => setItems(d?.notifications ?? [])).catch((e) => setError(e?.message || "Couldn't load notifications."));
  }, [req]);
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const markAll = async () => {
    try { await req("POST", "/notifications/read", { all: true }); load(); reload(); }
    catch (e: any) { setError(e?.message || "Could not save."); }
  };
  const markOne = async (n: Notice) => {
    setExpanded(expanded === n.id ? "" : n.id);
    if (n.read_at) return;
    try { await req("POST", "/notifications/read", { ids: [n.id] }); setItems((l) => (l ?? []).map((x) => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)); reload(); }
    catch { /* stays unread */ }
  };

  if (!enabled) return null;
  return (
    <div ref={box} style={{ position: "relative", flexShrink: 0 }}>
      <button data-testid="notification-bell" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} onClick={() => setOpen((o) => !o)}
        style={{ ...S.btn, ...S.btnGhost, position: "relative", padding: "6px 10px", fontSize: 15, lineHeight: 1 }}>
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span data-testid="notification-count" style={{ position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9, padding: "0 5px",
            background: C.danger, color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div data-testid="notification-panel" style={{ ...S.card, position: "absolute", right: 0, top: "calc(100% + 8px)", width: "min(420px, calc(100vw - 32px))",
          maxHeight: "70vh", overflowY: "auto", zIndex: 100, padding: 0, marginBottom: 0, boxShadow: "0 12px 32px rgba(0,0,0,0.35)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Notifications{unread ? ` · ${unread} unread` : ""}</div>
            <div style={{ display: "flex", gap: 6 }}>
              {unread > 0 && <button onClick={markAll} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 8px" }}>Mark all read</button>}
              <button onClick={() => { setOpen(false); onOpenAlerts(); }} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 8px" }}>Alerts →</button>
            </div>
          </div>
          {error && <div style={{ fontSize: 12, color: C.danger, padding: "10px 14px" }}>{error}</div>}
          {!items && !error && <div style={{ fontSize: 12, color: C.muted, padding: "10px 14px" }}>Loading…</div>}
          {items && !items.length && <div style={{ fontSize: 12, color: C.muted, padding: "14px" }}>Nothing yet. Client problems and billing notices appear here instead of one email each.</div>}
          {(items ?? []).map((n) => (
            <button key={n.id} onClick={() => markOne(n)} data-testid="notification-item"
              style={{ display: "block", width: "100%", textAlign: "left", background: n.read_at ? "transparent" : "rgba(0,212,255,0.06)", border: "none",
                borderBottom: `1px solid ${C.border}`, padding: "10px 14px", cursor: "pointer", color: C.text }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                {!n.read_at && <span style={{ width: 7, height: 7, borderRadius: 4, background: C.accent, flexShrink: 0 }} />}
                <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, flexShrink: 0 }}>{CATEGORY_WORD[n.category] ?? n.category}</span>
                <span style={{ fontSize: 11, color: C.muted, marginLeft: "auto", whiteSpace: "nowrap" }}>{ago(n.created_at)}</span>
              </div>
              <div style={{ fontSize: 13, marginTop: 3, lineHeight: 1.4 }}>{n.title}</div>
              {expanded === n.id && n.detail && <div style={{ fontSize: 12, color: C.muted, marginTop: 6, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{n.detail}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
