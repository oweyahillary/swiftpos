/**
 * NotificationBell — A589: the admin portal's bell, in the top bar.
 *
 * Owner, 2026-10-25: "till not closed should not come as an email for each client; let it be a notification on the admin
 * portal". The client problems the watchdog opens (a day not closed, a POS not syncing …) and ZapTill's billing notices
 * (an invoice issued, unpaid day 5, locked …) land here instead of one email each (public.admin_notifications, migration
 * 174; GET /api/admin/notifications). The number is the unread ones, re-read every 2 minutes; "Mark all read" clears it.
 *
 * A609 (owner, 2026-10-29: "the admin notification is unreadable on a mobile browser"): the panel was frosted glass
 * (S.card, 4.5% white) inside the top bar's own backdrop blur — a nested blur that phones (and most browsers) do not draw,
 * so the page's text showed straight through it — and it hung from the bell, so at 360 px it could run off the left edge.
 * Now it is drawn on the page itself (a portal): a SOLID dark surface, on a phone a sheet across the top of the screen with
 * a 12-px gutter (never wider than the screen), the list scrolling inside it, larger type; from 640 px a 420-px dropdown
 * under the bell, as before.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { C, S } from "./theme";
import { ago } from "./AlertsPage";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface Notice {
  id: string; category: string; business_id: string | null; title: string; detail?: string | null;
  data?: Record<string, any> | null; created_at: string; read_at?: string | null;
}

/** A609: the panel's own solid surface (the portal's colour, select menus' too) — never see-through. */
const PANEL_BG = "#0d1526";
const PHONE = "(max-width: 639px)";

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
  const panel = useRef<HTMLDivElement>(null);   // A609: the panel is portalled, so "outside" checks it too
  const [phone, setPhone] = useState(() => { try { return window.matchMedia(PHONE).matches; } catch { return false; } });
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(PHONE); } catch { return; }
    const on = () => setPhone(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  // From 640 px the dropdown hangs under the bell: where the bell is, read when it opens and on a resize.
  useEffect(() => {
    if (!open) return;
    const place = () => { const r = box.current?.getBoundingClientRect(); if (r) setAnchor({ top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right) }); };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const load = useCallback(() => {
    setError("");
    req("GET", "/notifications?limit=30").then((d) => setItems(d?.notifications ?? [])).catch((e) => setError(e?.message || "Couldn't load notifications."));
  }, [req]);
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current && !box.current.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
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
      {open && createPortal(
        <div ref={panel} data-testid="notification-panel" role="dialog" aria-label="Notifications"
          style={{ position: "fixed", zIndex: 1000, background: PANEL_BG, border: `1px solid ${C.border}`, borderRadius: 14, color: C.text,
            boxShadow: "0 16px 40px rgba(0,0,0,0.55)", display: "flex", flexDirection: "column", overflow: "hidden", boxSizing: "border-box",
            ...(phone
              ? { left: 12, right: 12, top: 12, maxHeight: "calc(100dvh - 24px)" }
              : { right: anchor?.right ?? 16, top: anchor?.top ?? 60, width: "min(420px, calc(100vw - 24px))", maxHeight: "min(70vh, calc(100dvh - 80px))" }) }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: `1px solid ${C.border}`, flexShrink: 0, flexWrap: "wrap" }}>
            <div style={{ fontSize: phone ? 15 : 13, fontWeight: 600 }}>Notifications{unread ? ` · ${unread} unread` : ""}</div>
            <div style={{ display: "flex", gap: 6 }}>
              {unread > 0 && <button onClick={markAll} style={{ ...S.btn, ...S.btnGhost, fontSize: phone ? 13 : 11, padding: phone ? "6px 10px" : "4px 8px" }}>Mark all read</button>}
              <button onClick={() => { setOpen(false); onOpenAlerts(); }} style={{ ...S.btn, ...S.btnGhost, fontSize: phone ? 13 : 11, padding: phone ? "6px 10px" : "4px 8px" }}>Alerts →</button>
              {phone && <button onClick={() => setOpen(false)} aria-label="Close notifications" style={{ ...S.btn, ...S.btnGhost, fontSize: 13, padding: "4px 9px", lineHeight: 1 }}>✕</button>}
            </div>
          </div>
          <div style={{ overflowY: "auto", overscrollBehavior: "contain", flex: 1, minHeight: 0 }}>
          {error && <div style={{ fontSize: 12, color: C.danger, padding: "10px 14px" }}>{error}</div>}
          {!items && !error && <div style={{ fontSize: 12, color: C.muted, padding: "10px 14px" }}>Loading…</div>}
          {items && !items.length && <div style={{ fontSize: phone ? 14 : 12, color: C.muted, padding: "14px" }}>Nothing yet. Client problems and billing notices appear here instead of one email each.</div>}
          {(items ?? []).map((n) => (
            <button key={n.id} onClick={() => markOne(n)} data-testid="notification-item"
              style={{ display: "block", width: "100%", textAlign: "left", background: n.read_at ? "transparent" : "rgba(0,212,255,0.06)", border: "none",
                borderBottom: `1px solid ${C.border}`, padding: "10px 14px", cursor: "pointer", color: C.text }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                {!n.read_at && <span style={{ width: 7, height: 7, borderRadius: 4, background: C.accent, flexShrink: 0 }} />}
                <span style={{ fontSize: phone ? 11 : 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{CATEGORY_WORD[n.category] ?? n.category}</span>
                <span style={{ fontSize: phone ? 12 : 11, color: C.muted, marginLeft: "auto", whiteSpace: "nowrap", flexShrink: 0 }}>{ago(n.created_at)}</span>
              </div>
              <div style={{ fontSize: phone ? 15 : 13, marginTop: 3, lineHeight: 1.4, overflowWrap: "anywhere" }}>{n.title}</div>
              {expanded === n.id && n.detail && <div style={{ fontSize: phone ? 14 : 12, color: C.muted, marginTop: 6, whiteSpace: "pre-wrap", lineHeight: 1.5, overflowWrap: "anywhere" }}>{n.detail}</div>}
            </button>
          ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
