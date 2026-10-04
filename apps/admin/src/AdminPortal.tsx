import { useState, useEffect, useCallback } from "react";
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from "recharts";
import MigrationsPage from "./MigrationsPage";
import { visibleVersions, RECENT_VERSIONS } from "./desktopVersions";
import { POS_FEATURES, POS_FEATURE_KEYS } from "./lib/posFeatures";
import { RELEASE, releaseLabel, releasesDiffer } from "./lib/release";
import { cleanSubdomain, subdomainProblem, suggestSubdomain } from "./lib/tenantHost";   // A378: a client's own sign-in address
import { cleanPhone, displayPhone, DEFAULT_SUPPORT_PHONES } from "./lib/support";   // 0.6.35 (A384): a shop's own tech
import { C, S, SIDEBAR_W } from "./theme";   // A393: shared with the Alerts and Account pages
import AlertsPage, { AlertsSummary, useCriticalCount } from "./AlertsPage";   // A392
import SignInCodeCard from "./SignInCodeCard";   // A391


// ─── Shared types ─────────────────────────────────────────────────────────────
interface Admin { id: string; email: string; name: string; role: string; }
interface Client { id: string; name: string; type: string; status: string; created_at: string; }
interface Branch { id: string; name: string; deploy_mode: string; desktop_licensed: boolean; }
interface Feature { key: string; enabled: boolean; notes?: string; }
interface Plan { id: string; name: string; price_per_year: number; }
interface Subscription { id: string; plan_id: string; status: string; expires_at: string; plan?: Plan; }
interface Invoice { id: string; amount: number; status: string; due_date: string; payment_reference?: string; }
interface Note { id: string; body: string; created_at: string; admin_name: string; }
interface TechToken { id: string; admin_name: string; branch_id: string; expires_at: string; status: string; created_at: string; used_at?: string; tier: string; }
interface ModeSwitchReq { id: string; business_name: string; branch_name: string; current_mode: string; requested_mode: string; status: string; created_at: string; }

// ─── Config ──────────────────────────────────────────────────────────────────
const DEFAULT_API = "http://localhost:4000";

// A393: this browser's keys. The API address is read once from the key the portal used before the ZapTill rename, so
// an admin who changed it does not have to set it again.
const KEY = {
  api:     "zaptill_admin_api",
  token:   "zaptill_admin_token",
  user:    "zaptill_admin_user",
  expired: "zaptill_admin_expired",
  trust:   "zaptill_admin_otp_trust",   // A391: "remember this browser" — per admin email
};
const OLD_API_KEY = ["swift", "pos_admin_api"].join("");
const savedApi = () => { try { return localStorage.getItem(KEY.api) || localStorage.getItem(OLD_API_KEY) || ""; } catch { return ""; } };
const saveApi = (v: string) => { try { localStorage.setItem(KEY.api, v); } catch { /* private window */ } };
const trustKey = (email: string) => `${KEY.trust}:${String(email).trim().toLowerCase()}`;

// ─── API layer ────────────────────────────────────────────────────────────────
// ─── API hook ─────────────────────────────────────────────────────────────────
function useAdminApi() {
  const [apiUrl, setApiUrl] = useState(() => savedApi() || import.meta.env.VITE_API_URL || DEFAULT_API);
  const [token, setToken]   = useState(() => sessionStorage.getItem(KEY.token) || "");

  const req = useCallback(async (method, path, body) => {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/admin${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    // A391: the sign-in screen needs the reason (OTP_REQUIRED, OTP_INVALID …), not only the message.
    const fail = (msg: string) => Object.assign(new Error(msg), { code: data?.code, status: res.status, data });
    // Token expired/invalid — drop it so the app returns to the login screen with
    // a message, instead of silently rendering empty data (e.g. "0 clients").
    if (res.status === 401 && token) {
      sessionStorage.removeItem(KEY.token);
      sessionStorage.setItem(KEY.expired, "1");
      setToken("");
      throw fail("Your session expired. Please sign in again.");
    }
    if (!res.ok) throw fail(data.error || `Request failed: ${res.status}`);
    return data;
  }, [apiUrl, token]);

  return { req, token, setToken, apiUrl, setApiUrl };
}

// ─── Utilities ────────────────────────────────────────────────────────────────
const TYPE_META = {
  restaurant:    { label: "Restaurant",    color: "#f97316" },
  cafe:          { label: "Café",          color: "#a78bfa" },
  retail:        { label: "Retail",        color: "#60a5fa" },
  minimart:      { label: "Minimart",      color: "#34d399" },
  parking:       { label: "Parking",       color: "#fbbf24" },
  petrol_station:{ label: "Petrol Station",color: "#f43f5e" },
  other:         { label: "Other",         color: "#94a3b8" },
};

function healthColor(score) {
  if (score >= 80) return "#22c55e";
  if (score >= 60) return "#3b82f6";
  if (score >= 40) return "#f59e0b";
  return "#ef4444";
}

function fmt(n, currency = "KES") {
  return `${currency} ${Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0 })}`;
}

function timeAgo(iso) {
  if (!iso) return "Never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 0)      return new Date(iso).toLocaleDateString("en-KE"); // future date (e.g. expiry) — show the date, not negative "ago"
  if (d < 60)     return `${d}s ago`;
  if (d < 3600)   return `${Math.floor(d/60)}m ago`;
  if (d < 86400)  return `${Math.floor(d/3600)}h ago`;
  if (d < 604800) return `${Math.floor(d/86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-KE");
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
}

// D2 purge detector (Stage 1). ~6-month grace; financial records retained separately.
const PURGE_GRACE_DAYS = 180;
function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function isPurgeDue(biz) {
  return biz?.status === "suspended" && !!biz?.suspended_at && daysSince(biz.suspended_at) >= PURGE_GRACE_DAYS;
}

// ─── Shared confirm/prompt modal ──────────────────────────────────────────────
// One implementation for the whole admin app. useModal() returns Promise-based
// askConfirm / askPrompt (non-blocking replacements for window.confirm/prompt)
// plus a `modal` element the caller renders once. askConfirm resolves true/false;
// askPrompt resolves the entered string, or null if cancelled.
function useModal() {
  const [state, setState] = useState(null); // { kind:'confirm'|'prompt', message, value?, resolve }

  const askConfirm = (message) => new Promise(resolve => setState({ kind: 'confirm', message, resolve }));
  const askPrompt  = (message, value = '') => new Promise(resolve => setState({ kind: 'prompt', message, value, resolve }));
  const resolve    = (result) => setState(s => { s?.resolve(result); return null; });

  const modal = state && (
    <div
      onClick={() => resolve(state.kind === 'confirm' ? false : null)}
      style={{ position: "fixed", inset: 0, background: "rgba(3,6,16,0.6)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: C.surface, backdropFilter: "blur(24px) saturate(150%)", WebkitBackdropFilter: "blur(24px) saturate(150%)", border: `1px solid ${C.border}`, borderRadius: 18, padding: 20, width: "min(420px, 92vw)", boxShadow: "0 24px 70px rgba(2,6,16,0.55), inset 0 1px 0 rgba(255,255,255,0.06)" }}>
        <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.5 }}>{state.message}</div>
        {state.kind === 'prompt' && (
          <input
            autoFocus
            style={{ ...S.input, width: "100%", marginBottom: 4 }}
            value={state.value}
            onChange={e => setState(s => ({ ...s, value: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') resolve(state.value); if (e.key === 'Escape') resolve(null); }}
          />
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => resolve(state.kind === 'confirm' ? false : null)}>Cancel</button>
          <button style={{ ...S.btn, ...S.btnPrimary }} onClick={() => resolve(state.kind === 'confirm' ? true : state.value)}>
            {state.kind === 'confirm' ? 'Confirm' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );

  return { askConfirm, askPrompt, modal };
}


// ─── SVG icon helper (replaces emoji in TYPE_META and status indicators) ──────
type SvgProps = { size?: number; color?: string; style?: React.CSSProperties };

function IconCafe({ size = 18, color = "currentColor", style }: SvgProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>;
}
function IconStore({ size = 18, color = "currentColor", style }: SvgProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
}
function IconFuel({ size = 18, color = "currentColor", style }: SvgProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden><path d="M3 22V4a2 2 0 012-2h8a2 2 0 012 2v18"/><path d="M18 10l2 2v8a2 2 0 01-2 2h-1"/><line x1="3" y1="22" x2="20" y2="22"/><line x1="7" y1="6" x2="11" y2="6"/></svg>;
}
function IconBuilding({ size = 18, color = "currentColor", style }: SvgProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 10h8M8 14h8M8 18h4"/></svg>;
}
function IconGlobe({ size = 22, color = "currentColor", style }: SvgProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>;
}
function IconLock({ size = 22, color = "currentColor", style }: SvgProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>;
}
// Health dot — coloured circle, no emoji
function HealthDot({ color }: { color: string }) {
  return <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0 }} />;
}

// Maps business type to an inline SVG icon element
function TypeIcon({ type, size = 18, style }: { type: string; size?: number; style?: React.CSSProperties }) {
  const color = TYPE_META[type as keyof typeof TYPE_META]?.color ?? "#94a3b8";
  switch (type) {
    case "cafe":           return <IconCafe    size={size} color={color} style={style} />;
    case "minimart":       return <IconStore   size={size} color={color} style={style} />;
    case "petrol_station": return <IconFuel    size={size} color={color} style={style} />;
    case "restaurant":     return <IconStore   size={size} color={color} style={style} />;
    case "retail":         return <IconStore   size={size} color={color} style={style} />;
    case "parking":        return <IconBuilding size={size} color={color} style={style} />;
    default:               return <IconBuilding size={size} color={color} style={style} />;
  }
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    active:    { bg: "rgba(34,197,94,0.12)", color: "#22c55e" },
    suspended: { bg: "rgba(239,68,68,0.12)", color: "#ef4444" },
    cancelled: { bg: "rgba(100,116,139,0.12)", color: "#94a3b8" },
    paid:      { bg: "rgba(34,197,94,0.12)", color: "#22c55e" },
    pending:   { bg: "rgba(251,191,36,0.12)", color: "#fbbf24" },
    overdue:   { bg: "rgba(239,68,68,0.12)", color: "#ef4444" },
    draft:     { bg: "rgba(100,116,139,0.12)", color: "#94a3b8" },
    trial:     { bg: "rgba(0,212,255,0.12)", color: C.accent },
    expired:   { bg: "rgba(239,68,68,0.12)", color: "#ef4444" },
  };
  const m = map[status] || map.draft;
  return <span style={{ ...S.badge, background: m.bg, color: m.color }}>{status}</span>;
}

// ─── Health bar ───────────────────────────────────────────────────────────────
function HealthBar({ score }) {
  const color = healthColor(score);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 28, fontFamily: "monospace" }}>{score}</span>
    </div>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginPage({ onLogin, apiUrl, setApiUrl, req }) {
  const [email, setEmail]     = useState("");
  const [password, setPass]   = useState("");
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [apiInput, setApiInput] = useState(apiUrl);
  // A391: the second step — the one-time code (emailed, or from the admin's authenticator app).
  const [otp, setOtp]         = useState(null);   // null = password step; { method, sentTo, note }
  const [code, setCode]       = useState("");
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    if (sessionStorage.getItem(KEY.expired)) {
      sessionStorage.removeItem(KEY.expired);
      setError("Your session expired. Please sign in again.");
    }
  }, []);

  async function signIn(extra = {}) {
    setError(""); setLoading(true);
    let trust = "";
    try { trust = localStorage.getItem(trustKey(email)) || ""; } catch { /* private window */ }
    try {
      const r = await req("POST", "/auth/login", {
        email, password, ...(trust ? { otp_trust: trust } : {}), ...extra,
      });
      try { if (r.otp_trust) localStorage.setItem(trustKey(email), r.otp_trust); } catch { /* private window */ }
      sessionStorage.setItem(KEY.token, r.token);
      onLogin(r.token, r.admin);
    } catch (err) {
      if (err.code === "OTP_REQUIRED") {
        try { localStorage.removeItem(trustKey(email)); } catch { /* ignore */ }
        setOtp({ method: err.data?.method, sentTo: err.data?.sent_to, note: (extra as any).otp_resend ? "A new code is on its way." : "" });
        setCode("");
      } else if (otp && (err.code === "OTP_INVALID" || err.code === "OTP_EXPIRED")) {
        setError(err.message); setCode("");
      } else {
        setError(err.message);
        if (!String(err.code || "").startsWith("OTP_")) setOtp(null);
      }
    }
    finally { setLoading(false); }
  }

  function submit(e) {
    e.preventDefault();
    if (otp) signIn({ otp_code: code, otp_remember: remember });
    else signIn();
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 380, padding: 36, background: C.surface, borderRadius: 16, border: `1px solid ${C.border}` }}>
        <div style={{ marginBottom: 28, textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: C.accent, fontFamily: "'Space Grotesk', sans-serif" }}>ZapTill</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>Admin portal</div>
        </div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {!otp ? (
            <>
              <div>
                <label style={S.label}>Email</label>
                <input style={S.input} type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus autoComplete="username" required />
              </div>
              <div>
                <label style={S.label}>Password</label>
                <input style={S.input} type="password" value={password} onChange={e => setPass(e.target.value)} autoComplete="current-password" required />
              </div>
            </>
          ) : (
            <div data-testid="otp-step">
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Enter your sign-in code</div>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
                {otp.method === "totp"
                  ? "Open your authenticator app and type the 6-digit code for ZapTill."
                  : `We emailed a 6-digit code to ${otp.sentTo || "your email"}. It works for 10 minutes.`}
                {otp.note ? ` ${otp.note}` : ""}
              </div>
              <input style={{ ...S.input, fontSize: 22, letterSpacing: 8, textAlign: "center" }} inputMode="numeric" autoComplete="one-time-code"
                autoFocus maxLength={7} value={code} onChange={e => setCode(e.target.value.replace(/[^\d]/g, ""))} placeholder="••••••" />
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.muted, marginTop: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                Remember this browser for 30 days
              </label>
            </div>
          )}
          {error && <div style={{ fontSize: 12, color: C.danger, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6 }}>{error}</div>}
          <button type="submit" disabled={loading || (otp && code.length !== 6)} style={{ ...S.btn, ...S.btnPrimary, padding: "11px", marginTop: 4, opacity: loading || (otp && code.length !== 6) ? 0.6 : 1 }}>
            {loading ? (otp ? "Checking…" : "Signing in…") : otp ? "Verify and sign in" : "Sign in"}
          </button>
          {otp && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button type="button" onClick={() => { setOtp(null); setCode(""); setError(""); }} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>← Back</button>
              {otp.method !== "totp" && (
                <button type="button" disabled={loading} onClick={() => signIn({ otp_resend: true })} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>Send a new code</button>
              )}
            </div>
          )}
        </form>

        {!otp && (
          <>
            <button onClick={() => setShowApi(s => !s)} style={{ background: "none", border: "none", color: C.muted, width: "100%", marginTop: 18, fontSize: 11, cursor: "pointer" }}>
              {showApi ? "Hide server address" : "Server address…"}
            </button>
            {showApi && (
              <div style={{ marginTop: 10 }}>
                <input style={S.input} value={apiInput} onChange={e => setApiInput(e.target.value)} placeholder="https://api.zaptill.co.ke" />
                <button onClick={() => { setApiUrl(apiInput); saveApi(apiInput); }}
                  style={{ ...S.btn, ...S.btnPrimary, width: "100%", marginTop: 8 }}>Save server address</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
// 0.6.28 (owner: "add versioning … so that i can tell which one i am running"): this portal's release and build, and the
// cloud's (GET /api/admin/version). Amber when they differ — one was deployed, the other not yet.
function ReleaseLine() {
  const { req } = useAdminApi();
  const [cloud, setCloud] = useState(null);
  useEffect(() => { req("GET", "/version", undefined).then((c) => c?.release && setCloud(c)).catch(() => {}); }, [req]);
  const differ = releasesDiffer(RELEASE, cloud?.release);
  return (
    <div data-testid="release-badge" style={{ fontSize: 10, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>
      <div>ZapTill {releaseLabel(RELEASE, __WEB_BUILD_SHA__)}</div>
      {cloud && <div style={differ ? { color: "#f59e0b" } : undefined}>cloud {releaseLabel(cloud.release, cloud.commit)}{differ ? " — not the same release" : ""}</div>}
    </div>
  );
}

// A393 (owner, 2026-10-04: "make admin portal ui user friendly i feel we have thrown things randomly everywhere"): the
// menu in four groups — what needs you, your clients, money and support, and the system — with the open critical
// alerts counted on Alerts.
const NAV_GROUPS = [
  { title: "Overview", items: [
    { id: "dashboard", icon: "▦", label: "Dashboard" },
    { id: "alerts",    icon: "⚠", label: "Alerts" },
  ] },
  { title: "Clients", items: [
    { id: "clients",    icon: "◈", label: "All clients" },
    { id: "new_client", icon: "+", label: "New client" },
  ] },
  { title: "Money & support", items: [
    { id: "billing", icon: "◉", label: "Billing" },
    { id: "tech",    icon: "⌘", label: "Tech access" },
  ] },
  { title: "System", items: [
    { id: "team",       icon: "◎", label: "Team", superOnly: true },
    { id: "audit",      icon: "≡", label: "Audit log" },
    { id: "migrations", icon: "⛃", label: "Database" },
    { id: "account",    icon: "⊙", label: "My account" },
  ] },
];

function Sidebar({ page, setPage, admin, onLogout, isOpen, onClose, critical = 0 }) {
  function navigate(id) {
    setPage(id);
    onClose?.(); // close mobile drawer on nav
  }
  const current = page === "client_detail" ? "clients" : page;

  return (
    <>
      {/* Mobile overlay backdrop */}
      {isOpen && (
        <div onClick={onClose}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 99, display: "none" }}
          className="sp-mobile-backdrop" />
      )}
      <aside style={{ ...S.sidebar, transform: isOpen ? "translateX(0)" : undefined }}
        className={`sp-sidebar${isOpen ? " sp-sidebar-open" : ""}`}>
        <div style={{ padding: "20px 16px 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.accent, letterSpacing: "-0.01em", fontFamily: "'Space Grotesk', sans-serif" }}>ZapTill</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Admin portal</div>
          </div>
          {/* Close button — mobile only */}
          <button onClick={onClose} className="sp-close-btn"
            style={{ background: "transparent", border: "none", color: C.muted, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 4, display: "none" }}>
            ✕
          </button>
        </div>
        <nav style={{ flex: 1, padding: "8px 8px 12px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }} data-testid="nav">
          {NAV_GROUPS.map(g => {
            const items = g.items.filter(n => !(n as any).superOnly || admin?.role === "super_admin");
            if (!items.length) return null;
            return (
              <div key={g.title} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", padding: "0 10px 4px", opacity: 0.8 }}>{g.title}</div>
                {items.map(n => {
                  const on = current === n.id;
                  return (
                    <button key={n.id} onClick={() => navigate(n.id)} data-testid={`nav-${n.id}`}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, fontSize: 13, fontWeight: 500, border: "none", cursor: "pointer", textAlign: "left", background: on ? "rgba(0,212,255,0.08)" : "transparent", color: on ? C.accent : C.muted, fontFamily: "inherit", transition: "all 0.15s", width: "100%" }}>
                      <span style={{ fontSize: 14, width: 20, textAlign: "center", flexShrink: 0 }}>{n.icon}</span>
                      <span style={{ flex: 1 }}>{n.label}</span>
                      {n.id === "alerts" && critical > 0 && (
                        <span data-testid="alerts-badge" style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: C.danger, borderRadius: 10, padding: "1px 7px" }}>{critical}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, color: C.text, fontWeight: 600, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{admin?.name || "Admin"}</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{admin?.email}</div>
          <button onClick={onLogout} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "6px 12px", width: "100%" }}>Sign out</button>
          <ReleaseLine />
        </div>
      </aside>
    </>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function DashboardPage({ req, onOpenAlerts, onSelectClient }) {
  const [stats, setStats]   = useState(null);
  const [health, setHealth] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    Promise.all([req("GET", "/fleet/stats"), req("GET", "/fleet/health")])
      .then(([s, h]) => { setStats(s); setHealth(h); })
      .catch(err => setLoadError(err?.message || "Couldn't load fleet data."))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 24, color: C.muted }}>Loading fleet data…</div>;

  // Don't render a dashboard full of zeros when the load actually failed — that
  // looks like real "0 clients" data. Show the error (a 401 also clears the token
  // via req() and returns to login).
  if (loadError || !stats) {
    return (
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
        <div style={{ color: C.danger, fontSize: 14 }}>{loadError || "Couldn't load fleet data."}</div>
        <button onClick={() => window.location.reload()} style={{ ...S.btn, ...S.btnPrimary }}>Retry</button>
      </div>
    );
  }

  const critical    = health.filter(b => b.health_score < 40).length;
  const needsAttn   = health.filter(b => b.health_score >= 40 && b.health_score < 70).length;
  const healthy     = health.filter(b => b.health_score >= 70).length;

  // G8: the "Fleet Health" card must chart HEALTH, not business type. These bars
  // visualise the three bands shown as numbers above them. (Clients-by-Type gets
  // its own card in the Phase 3 refresh — see docs/ADMIN-PORTAL-PLAN.md.)
  const healthBuckets = [
    { band: "Healthy",   count: healthy,   color: "#22c55e" },
    { band: "Attention", count: needsAttn, color: "#f59e0b" },
    { band: "Critical",  count: critical,  color: "#ef4444" },
  ];

  return (
    <div style={S.content}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Dashboard</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: "4px 0 0" }}>Your clients at a glance</p>
      </div>

      {/* A393: what needs you first */}
      <AlertsSummary req={req} onOpen={onOpenAlerts} />

      {/* KPI row */}
      <div className="sp-kpi-grid">
        {[
          { label: "Total Clients", value: stats?.total ?? 0, color: C.accent },
          { label: "Active",        value: stats?.active ?? 0, color: "#22c55e" },
          { label: "Suspended",     value: stats?.suspended ?? 0, color: C.danger },
          { label: "New This Month",value: stats?.new_this_month ?? 0, color: "#a78bfa" },
          { label: "Revenue MTD",   value: fmt(stats?.revenue_mtd), color: "#fbbf24", mono: true },
        ].map(k => (
          <div key={k.label} style={S.kpiCard}>
            <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>{k.label}</div>
            <div style={{ fontSize: k.mono ? 18 : 28, fontWeight: 700, color: k.color, fontFamily: k.mono ? "monospace" : "'Space Grotesk', sans-serif" }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="sp-two-col">
        {/* Health breakdown */}
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Fleet Health</div>
          <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
            {([["Healthy", healthy, "#22c55e"], ["Attention", needsAttn, "#f59e0b"], ["Critical", critical, C.danger]] as [string, number, string][]).map(([l, v, c]) => (
              <div key={l} style={{ textAlign: "center", flex: 1 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: c }}>{v}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{l}</div>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={healthBuckets} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="band" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8 }} />
              <Bar dataKey="count" radius={[4,4,0,0]}>
                {healthBuckets.map((b, i) => <Cell key={i} fill={b.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Recent signups */}
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Recent Signups</div>
          {(stats?.recent_signups || []).map(b => (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <TypeIcon type={b.type} size={18} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{TYPE_META[b.type]?.label}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <StatusBadge status={b.status} />
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{timeAgo(b.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Health table */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Client Health Scores</div>
          <span style={{ fontSize: 11, color: C.muted }}>{health.length} clients</span>
        </div>
        <div className="sp-table-wrap"><table style={S.table}>
          <thead>
            <tr>
              {["Client","Type","Status","Health","Last Order","Orders MTD","Subscription"].map(h => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {health.slice(0, 20).map(b => (
              <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => onSelectClient?.(b)}>
                <td style={S.td}><span style={{ fontWeight: 500 }}>{b.name}</span></td>
                <td style={S.td}><TypeIcon type={b.type} size={16} style={{ marginRight: 4, verticalAlign: "middle" }} /> <span style={{ fontSize: 12, color: C.muted }}>{TYPE_META[b.type]?.label}</span></td>
                <td style={S.td}><StatusBadge status={b.status} /></td>
                <td style={{ ...S.td, minWidth: 120 }}><HealthBar score={b.health_score} /></td>
                <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{timeAgo(b.last_order_at)}</td>
                <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{b.orders_this_month}</td>
                <td style={S.td}><StatusBadge status={b.subscription?.status || "none"} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

// ─── SUPPORT TECH (0.6.35, A384) ──────────────────────────────────────────────
// Allocate a team member to a client: their name and number appear on the shop's Help (the till, offline too, after its
// next sync; and the web). None → ZapTill support's numbers.
function SupportTechPicker({ req, clientId, current, onSaved }) {
  const [techs, setTechs]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  useEffect(() => {
    req("GET", "/techs").then(setTechs).catch(e => { setTechs([]); setError(e?.message || "Couldn't load the team."); });
  }, [req]);

  const choose = async (id) => {
    setSaving(true); setError("");
    try {
      await req("PATCH", `/clients/${clientId}`, { support_admin_id: id || null });
      onSaved(id ? (techs || []).find(t => t.id === id) ?? null : null);
    } catch (e) { setError(e?.message || "Could not save the tech."); }
    finally { setSaving(false); }
  };

  const shown = current?.phone
    ? `${current.name} · ${displayPhone(current.phone)}`
    : current ? `${current.name} — no number yet (the shop sees ZapTill support)` : `None — ZapTill support (${DEFAULT_SUPPORT_PHONES.map(displayPhone).join(" / ")})`;

  return (
    <div data-testid="support-tech" style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Support tech</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <select style={{ ...S.input, width: 220 }} disabled={saving || techs === null}
          value={current?.id ?? ""} onChange={e => choose(e.target.value)}>
          <option value="">None (ZapTill support)</option>
          {(techs || []).map(t => (
            <option key={t.id} value={t.id}>{t.name}{t.phone ? ` · ${displayPhone(t.phone)}` : " (no number)"}</option>
          ))}
        </select>
        {saving && <span style={{ fontSize: 11, color: C.muted }}>Saving…</span>}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Shown on the shop's Help: {shown}. Tills pick it up at their next sync.</div>
      {error && <div style={{ fontSize: 11, color: C.danger, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ─── CLIENTS LIST ─────────────────────────────────────────────────────────────
function ClientsPage({ req, onSelectClient }) {
  const [clients, setClients] = useState([]);
  const [total, setTotal]     = useState(0);
  const [search, setSearch]   = useState("");
  const [status, setStatus]   = useState("");
  const [type, setType]       = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      if (type)   params.set("type", type);
      const data = await req("GET", `/clients?${params}`);
      setClients(data.clients); setTotal(data.total);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, [search, status, type]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={S.content}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Clients</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: "4px 0 0" }}>{total} total clients</p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input style={{ ...S.input, maxWidth: 280 }} placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)} />
        <select style={{ ...S.input, width: "auto" }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select style={{ ...S.input, width: "auto" }} value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(TYPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </select>
      </div>

      <div style={S.card}>
        <div className="sp-table-wrap"><table style={S.table}>
          <thead>
            <tr>{["Client","Type","Status","Currency","Phone","Joined",""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: C.muted, padding: 40 }}>Loading…</td></tr>
            ) : clients.map(b => (
              <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => onSelectClient(b)}>
                <td style={S.td}>
                  <div style={{ fontWeight: 600 }}>{b.name}</div>
                  <div style={{ fontSize: 11, color: C.muted, fontFamily: "monospace" }}>{b.id.slice(0,8)}…</div>
                </td>
                <td style={S.td}><TypeIcon type={b.type} size={16} style={{ marginRight: 4, verticalAlign: "middle" }} /> <span style={{ fontSize: 12, color: TYPE_META[b.type]?.color }}>{TYPE_META[b.type]?.label}</span></td>
                <td style={S.td}><StatusBadge status={b.status} />{isPurgeDue(b) && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 20, padding: "2px 7px" }}>purge-due</span>}</td>
                <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{b.currency}</td>
                <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{b.phone || "—"}</td>
                <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{fmtDate(b.created_at)}</td>
                <td style={S.td}><button style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "5px 10px" }} onClick={e => { e.stopPropagation(); onSelectClient(b); }}>View →</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

// ─── CLIENT DETAIL ────────────────────────────────────────────────────────────
function ClientDetailPage({ client, req, onBack }) {
  const [tab, setTab]     = useState("overview");
  const [detail, setDetail] = useState(null);
  const [features, setFeatures] = useState([]);
  const [subs, setSubs]   = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [notes, setNotes] = useState([]);
  const [plans, setPlans] = useState([]);
  const [branches, setBranches] = useState([]);
  const [licencingBranch, setLicencingBranch] = useState(null);
  const [enrolBranch, setEnrolBranch] = useState(null);   // A69: branch currently minting a code
  const [addingBranch, setAddingBranch] = useState(false);       // G1: add-branch form open
  const [branchForm, setBranchForm] = useState({ name: "", address: "", phone: "" });
  const [closingBranch, setClosingBranch] = useState(null);      // G2: branch currently closing/reopening
  const [purgePreview, setPurgePreview] = useState(null);        // Stage 2: dry-run preview data
  const [branchView, setBranchView] = useState(null);           // Branches tab: selected branch (drill-down)
  const [deviceView, setDeviceView] = useState(null);           // Branches tab: selected till
  const [techAudit, setTechAudit] = useState(null);             // Branches tab: tech audit log for the till
  const [enrolResult, setEnrolResult] = useState(null);   // A69: { businessId, codes[], branchName, expiresAt }
  const [enrolError, setEnrolError] = useState("");       // 2026-10-02: shown by the branches, not at the top of the page
  const [devices, setDevices] = useState([]);             // A70: enrolled-device roster
  const [editing, setEditing] = useState(false);          // G5: business edit panel open
  const [editForm, setEditForm] = useState({ name: "", type: "", currency: "" });
  const [loading, setLoading] = useState(true);
  const [newNote, setNewNote] = useState("");
  const [error, setError] = useState("");
  const [expiryDraft, setExpiryDraft] = useState("");   // A147: web-access expiry setter
  const [savingExpiry, setSavingExpiry] = useState(false);
  // A348: desktop updates per business — releases the cloud can serve, the version picked, saving.
  const [desktopReleases, setDesktopReleases] = useState(null);   // null = loading; { error } on failure
  const [desktopPick, setDesktopPick] = useState("");
  // A356: GitHub's refusal, when the list shown is the last good one; and the short list's "show all" switch.
  const [desktopWarning, setDesktopWarning] = useState(null);
  const [showAllVersions, setShowAllVersions] = useState(false);
  const [savingDesktop, setSavingDesktop] = useState(false);
  // A378: the client's own sign-in address (africanfries.<root>) — ZapTill sets it here, never the client.
  const [subDraft, setSubDraft] = useState(null);          // null = not editing
  const [subError, setSubError] = useState("");
  const [savingSub, setSavingSub] = useState(false);
  const { askConfirm, askPrompt, modal } = useModal();

  useEffect(() => {
    Promise.all([
      req("GET", `/clients/${client.id}`),
      req("GET", `/clients/${client.id}/features`),
      req("GET", `/clients/${client.id}/subscription`),
      req("GET", `/clients/${client.id}/billing`),
      req("GET", `/clients/${client.id}/notes`),
      req("GET", "/plans"),
      req("GET", `/clients/${client.id}/branches`).catch(() => []),
      req("GET", `/clients/${client.id}/devices`).catch(() => ({ devices: [] })),
    ]).then(([d, f, s, inv, n, p, br, dev]) => {
      setDetail(d); setFeatures(f); setSubs(s); setInvoices(inv); setNotes(n); setPlans(p);
      setBranches(br || []);
      setDevices((dev && dev.devices) || []);
    }).catch(e => setError(e.message))
      .finally(() => setLoading(false));
    req("GET", "/desktop-releases?meta=1")
      .then(r => {
        // A356: { releases, warning } from a 0.6.18 cloud; a bare array from an older one.
        setDesktopReleases(Array.isArray(r) ? r : Array.isArray(r?.releases) ? r.releases : []);
        setDesktopWarning(Array.isArray(r) ? null : (r?.warning ?? null));
      })
      .catch(e => setDesktopReleases({ error: e.message }));
  }, [client.id]);

  async function toggleFeature(key, enabled) {
    try {
      await req("PATCH", `/clients/${client.id}/features/${key}`, { enabled });
      setFeatures(prev => {
        const existing = prev.find(f => f.key === key);
        if (existing) return prev.map(f => f.key === key ? { ...f, enabled } : f);
        return [...prev, { key, enabled }];
      });
    } catch(e) { setError(e.message); }
  }

  async function suspend() {
    const reason = await askPrompt("Reason for suspension:");
    if (!reason) return;
    await req("POST", `/clients/${client.id}/suspend`, { reason });
    setDetail(d => ({ ...d, status: "suspended" }));
  }

  async function activate() {
    await req("POST", `/clients/${client.id}/activate`, {});
    setDetail(d => ({ ...d, status: "active" }));
  }

  async function resetOwnerPassword() {
    const pw = await askPrompt(`New password for the owner of "${d.name}" (min 8 characters):`);
    if (pw === null) return;               // cancelled
    if ((pw as string).length < 8) { await askConfirm("Password must be at least 8 characters — not changed."); return; }
    try {
      const r = await req("POST", `/clients/${client.id}/reset-owner-password`, { new_password: pw });
      await askConfirm(`Password reset for ${r?.email ?? "the owner"}. Share it securely — they can change it after signing in.`);
    } catch (e) {
      await askConfirm(`Could not reset password: ${e.message}`);
    }
  }

  async function addNote() {
    if (!newNote.trim()) return;
    const n = await req("POST", `/clients/${client.id}/notes`, { body: newNote });
    setNotes(prev => [n, ...prev]);
    setNewNote("");
  }

  async function markPaid(invoiceId) {
    const ref = await askPrompt("Payment reference (optional):");
    await req("PATCH", `/clients/${client.id}/billing/${invoiceId}`, { status: "paid", payment_reference: ref || null });
    setInvoices(prev => prev.map(i => i.id === invoiceId ? { ...i, status: "paid", payment_reference: ref } : i));
  }


  const webHostingFlag = features.find(f => f.key === 'web_hosting');
  const hasWebHosting  = webHostingFlag?.enabled === true;
  // A325: client branding Phase 2 — curated action themes (premium; off by default). While off, the client's
  // tills keep today's look and the web hides the theme picker. Price not decided: no invoice is raised here.
  const hasThemes = features.find(f => f.key === 'themes')?.enabled === true;

  // A147: set businesses.web_access_expires_at — the date the renewal ladder is
  // measured against (distinct from the legacy web_hosting on/off boolean above).
  async function setWebAccessExpiry(expires_at) {
    setSavingExpiry(true);
    try {
      const updated = await req("PATCH", `/clients/${client.id}/web-access`, { expires_at });
      setDetail(prev => prev ? { ...prev, web_access_expires_at: updated?.web_access_expires_at ?? null } : prev);
      setExpiryDraft("");
    } catch (e) { setError(e.message); }
    finally { setSavingExpiry(false); }
  }

  // A348: approve one desktop version for this business (its tills update to it within the hour), or hold (null).
  async function setDesktopVersion(version) {
    const msg = version
      ? `Approve desktop ${version} for ${detail?.name ?? 'this client'}? Their tills download it within the hour and install it the next time each till is closed.`
      : `Hold desktop updates for ${detail?.name ?? 'this client'}? Their tills stay on the version they run now.`;
    if (!(await askConfirm(msg))) return;
    setSavingDesktop(true);
    try {
      const updated = await req("PATCH", `/clients/${client.id}/desktop-version`, { version });
      setDetail(prev => prev ? { ...prev, desktop_approved_version: updated?.desktop_approved_version ?? null } : prev);
      setDesktopPick("");
    } catch (e) { setError(e.message); }
    finally { setSavingDesktop(false); }
  }

  async function toggleWebHosting(enable) {
    const confirmMsg = enable
      ? 'Enable web portal access? This will allow the client to log into the dashboard. Ensure payment of KES 10,000 has been received.'
      : 'Disable web portal access? The client will be locked out of the dashboard immediately.';
    if (!(await askConfirm(confirmMsg))) return;

    try {
      await req("PATCH", `/clients/${client.id}/features/web_hosting`, {
        enabled: enable,
        notes:   enable ? `Web hosting enabled by ${req.adminEmail || 'admin'} — KES 10,000 paid` : 'Web hosting disabled',
      });

      setFeatures(prev => {
        const existing = prev.find(f => f.key === 'web_hosting');
        if (existing) return prev.map(f => f.key === 'web_hosting' ? { ...f, enabled: enable } : f);
        return [...prev, { key: 'web_hosting', enabled: enable }];
      });

      // Auto-create invoice on enable
      if (enable) {
        try {
          await req("POST", `/clients/${client.id}/billing`, {
            description: 'Web Portal Hosting — Annual Access',
            amount:      10000,
            currency:    'KES',
          });
        } catch(e) { /* Invoice creation is non-fatal */ }
      }
    } catch(e) { setError(e.message); }
  }

  async function toggleThemes(enable) {
    const msg = enable
      ? 'Enable themes? The client can then pick an app theme on the Branding page; their tills pick it up within about 20 seconds.'
      : 'Disable themes? The client\'s tills return to the standard look within about 20 seconds. Their chosen theme is kept for later.';
    if (!(await askConfirm(msg))) return;
    try {
      await req("PATCH", `/clients/${client.id}/features/themes`, {
        enabled: enable,
        notes:   enable ? 'Themes enabled (client branding Phase 2)' : 'Themes disabled',
      });
      setFeatures(prev => {
        const existing = prev.find(f => f.key === 'themes');
        if (existing) return prev.map(f => f.key === 'themes' ? { ...f, enabled: enable } : f);
        return [...prev, { key: 'themes', enabled: enable }];
      });
    } catch(e) { setError(e.message); }
  }

  async function toggleBranchLicence(branch, licensed) {
    // Revoking is destructive (blocks the desktop app) — confirm first.
    if (!licensed && !(await askConfirm(`Revoke the desktop licence for "${branch.name}"? The desktop app on this branch will be blocked on its next sync.`))) return;
    const price = licensed ? await askPrompt(`One-off desktop licence fee for "${branch.name}" (KES). Leave blank to create invoice later:`) : null;
    const ref   = licensed && price ? await askPrompt("Payment reference (M-Pesa ref / bank ref):") : null;
    if (licensed && price === null) return; // user cancelled

    setLicencingBranch(branch.id);
    try {
      await req("POST", `/clients/${client.id}/branches/${branch.id}/licence`, {
        licensed,
        invoice_amount: price ? parseInt(price as string) : null,
        invoice_ref:    ref || null,
      });
      setBranches(prev => prev.map(b =>
        b.id === branch.id
          ? { ...b, desktop_licensed: licensed, desktop_licensed_at: licensed ? new Date().toISOString() : null }
          : b
      ));
    } catch(e) { setError(e.message); }
    finally { setLicencingBranch(null); }
  }

  // A69: mint one or more single-use, branch-bound codes. The branch must be
  // desktop-licensed (the server refuses otherwise). Batching mints N separate
  // single-use codes — it is NOT a reusable code.
  async function generateEnrolCode(branch) {
    const ans = await askPrompt(`How many tills for ${branch.name}? (1–20)`, "1");
    if (ans === null) return;                                   // cancelled
    const count = Math.max(1, Math.min(20, parseInt(ans as string, 10) || 1));
    setEnrolBranch(branch.id); setEnrolResult(null); setEnrolError("");
    try {
      const r = await req("POST", `/clients/${client.id}/branches/${branch.id}/enrol-code`, { count });
      setEnrolResult({ businessId: r.businessId, codes: r.codes || [], branchName: r.branchName || branch.name, expiresAt: r.expiresAt });
    } catch(e) { setEnrolError(`${branch.name}: ${e.message}`); }   // beside the branch, where the admin is looking
    finally { setEnrolBranch(null); }
  }

  // Stage 1: pre-purge export — download the client's normal user data as JSON.
  async function exportData() {
    try {
      const data = await req("GET", `/clients/${client.id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `zaptill-export-${client.id}.json`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(e?.message ?? "Export failed"); }
  }

  // Stage 2: non-destructive purge preview — counts what a purge WOULD delete.
  async function loadPurgePreview() {
    try { setPurgePreview(await req("GET", `/clients/${client.id}/purge-preview`)); }
    catch (e) { setError(e?.message ?? "Preview failed"); }
  }

  // Branches tab: drill from branch → tills → tech audit log.
  function openTills(b) { setBranchView(b); setDeviceView(null); setTechAudit(null); }
  async function openDeviceLog(dev) {
    setDeviceView(dev); setTechAudit(null);
    try { setTechAudit(await req("GET", `/clients/${client.id}/devices/${dev.id}/tech-audit`)); }
    catch (e) { setError(e?.message ?? "Failed to load tech log"); setTechAudit([]); }
  }

  // G1: admin creates a branch (owners are blocked — branches are billed separately).
  async function createBranch() {
    if (!branchForm.name.trim()) { await askConfirm("Branch name is required."); return; }
    try {
      const created = await req("POST", `/clients/${client.id}/branches`, {
        name:    branchForm.name.trim(),
        address: branchForm.address.trim() || undefined,
        phone:   branchForm.phone.trim() || undefined,
      });
      setBranches(prev => [...prev, created]);
      setBranchForm({ name: "", address: "", phone: "" });
      setAddingBranch(false);
    } catch (e) { setError(e?.message ?? "Failed to create branch"); }
  }

  // G2: admin closes/reopens a branch (main branch can't be closed).
  async function toggleBranchStatus(b) {
    const closing = b.status !== "inactive";
    const msg = closing
      ? `Close "${b.name}"? It is deactivated and hidden from the branch selector.${b.desktop_licensed ? " It still holds an active desktop licence — click Revoke to stop its tills and billing." : ""}`
      : `Reopen "${b.name}"? It becomes active again.`;
    if (!(await askConfirm(msg))) return;
    setClosingBranch(b.id);
    try {
      const updated = await req("PATCH", `/clients/${client.id}/branches/${b.id}`, { status: closing ? "inactive" : "active" });
      setBranches(prev => prev.map(x => x.id === b.id ? updated : x));
    } catch (e) { setError(e?.message ?? "Failed to update branch"); }
    finally { setClosingBranch(null); }
  }

  // G4: revoke a device (e.g. a lost/stolen till) straight from the fleet console.
  async function revokeDevice(dev) {
    if (!(await askConfirm(`Revoke "${dev.label}"? It is removed from the fleet and blocked on its next sync — it must re-enrol with a new code. Use this for a lost or stolen till.`))) return;
    try {
      await req("DELETE", `/clients/${client.id}/devices/${dev.id}`);
      setDevices(prev => prev.filter(x => x.id !== dev.id));
    } catch (e) { setError(e?.message ?? "Failed to revoke device"); }
  }

  // G6: change the owner's login email (mirrors the password-reset flow).
  async function changeOwnerEmail() {
    const em = await askPrompt(`New login email for the owner of "${d.name}":`, d.email ?? "");
    if (em === null) return;
    const email = String(em).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { await askConfirm("That doesn't look like a valid email — not changed."); return; }
    try {
      await req("POST", `/clients/${client.id}/change-owner-email`, { new_email: email });
      setDetail(prev => ({ ...prev, email }));
      await askConfirm(`Owner login email changed to ${email}.`);
    } catch (e) { setError(e?.message ?? "Failed to change owner email"); }
  }

  // A378: set or clear the client's sign-in address. Checked here first (shared/tenantHost.ts), then by the cloud.
  async function saveSubdomain() {
    const raw = String(subDraft ?? "").trim().toLowerCase();
    const clean = cleanSubdomain(raw);
    if (clean === undefined) { setSubError(subdomainProblem(raw) ?? "Not a valid address."); return; }
    setSavingSub(true); setSubError("");
    try {
      await req("PATCH", `/clients/${client.id}`, { subdomain: clean });
      const fresh = await req("GET", `/clients/${client.id}`);   // the cloud builds the full address
      setDetail(prev => ({ ...prev, subdomain: fresh?.subdomain ?? clean, sign_in_address: fresh?.sign_in_address ?? null,
                           tenant_root_domain: fresh?.tenant_root_domain ?? null }));
      setSubDraft(null);
    } catch (e) { setSubError(e?.message ?? "Could not save the sign-in address"); }
    finally { setSavingSub(false); }
  }

  // G5: edit the business's core details (wires the existing PATCH /clients/:id).
  async function saveEdit() {
    if (!editForm.name.trim()) { await askConfirm("Business name can't be empty."); return; }
    try {
      const updated = await req("PATCH", `/clients/${client.id}`, {
        name: editForm.name.trim(), type: editForm.type, currency: editForm.currency.trim() || undefined,
      });
      setDetail(prev => ({ ...prev,
        name:     updated?.name     ?? editForm.name.trim(),
        type:     updated?.type     ?? editForm.type,
        currency: updated?.currency ?? editForm.currency,
      }));
      setEditing(false);
    } catch (e) { setError(e?.message ?? "Failed to save changes"); }
  }

  // A391: the owner lost the phone with their authenticator app → back to emailed codes.
  async function resetOwnerOtp() {
    if (!(await askConfirm(`Reset the sign-in code for the owner of "${d.name}"? They will get their code by email at the next sign-in, and every browser they asked to be remembered must enter a code again.`))) return;
    try {
      await req("POST", `/clients/${client.id}/reset-owner-otp`, {});
      await askConfirm("Done — the owner now gets their sign-in code by email.");
    } catch (e) { setError(e?.message ?? "Could not reset the sign-in code"); }
  }

  if (loading) return <div style={{ padding: 24, color: C.muted }}>Loading client…</div>;

  const d = detail || client;
  const activeSub = subs.find(s => s.status === "active");
  const TYPE = TYPE_META[d.type] || TYPE_META.other;
  const licensedCount = branches.filter(b => b.desktop_licensed).length;
  const outstanding = invoices.filter(i => i.status !== "paid").reduce((s, i) => s + Number(i.amount), 0);

  // A393 (owner, 2026-10-04: "make admin portal ui user friendly i feel we have thrown things randomly everywhere"):
  // one header with the facts that matter, then one tab per job — nothing above the tabs but what needs attention.
  const TABS = [
    ["overview", "Overview"],
    ["branches", "Branches & tills"],
    ["billing",  "Plan & billing"],
    ["features", "Features"],
    ["updates",  "Desktop updates"],
    ["account",  "Owner & account"],
    ["notes",    `Notes${notes.length ? ` (${notes.length})` : ""}`],
  ];

  const fact = (label, value, color = C.text, onClick = null) => (
    <button key={label} onClick={onClick ?? undefined} disabled={!onClick}
      style={{ textAlign: "left", background: "rgba(255,255,255,0.03)", border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 12px", minWidth: 0, cursor: onClick ? "pointer" : "default", fontFamily: "inherit" }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color, marginTop: 3, lineHeight: 1.35 }}>{value}</div>
    </button>
  );

  const settingRow = (title, text, actions, testid = undefined) => (
    <div data-testid={testid} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 0", borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.5 }}>{text}</div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{actions}</div>
    </div>
  );

  const toggle = (on, onClick, label) => (
    <button onClick={onClick} aria-pressed={on} aria-label={label}
      style={{ flex: "0 0 auto", width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer", background: on ? "#22c55e" : C.border, position: "relative", transition: "background 0.2s" }}>
      <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: on ? 23 : 3, transition: "left 0.2s" }} />
    </button>
  );

  const enrolPanel = (
    <>
      {/* A69: minted codes — shown ONCE. Business ID once, then one code per till. */}
      {enrolError && (
        <div data-testid="enrol-error" style={{ marginTop: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, color: C.danger, fontSize: 13 }}>
          Could not issue an enrolment code — {enrolError}
        </div>
      )}
      {enrolResult && (
        <div style={{ marginTop: 12, padding: 12, background: C.accent + "14", border: `1px solid ${C.accent}55`, borderRadius: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Enrolment {enrolResult.codes.length === 1 ? "code" : `codes (${enrolResult.codes.length})`} — {enrolResult.branchName}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
            Single-use. Expire {new Date(enrolResult.expiresAt).toLocaleTimeString("en-KE")}. Give each till the Business ID + one code.
          </div>
          {[["Business ID", enrolResult.businessId],
            ...enrolResult.codes.map((c, i) => [enrolResult.codes.length > 1 ? `Code ${i + 1}` : "Code", c])
          ].map(([label, value], i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: C.muted, width: 84, flexShrink: 0 }}>{label}</span>
              <code style={{ fontSize: 13, fontWeight: 600, fontFamily: "monospace", flex: 1, wordBreak: "break-all" }}>{value}</code>
              <button onClick={() => navigator.clipboard?.writeText(value)}
                style={{ ...S.btn, ...S.btnGhost, fontSize: 10, padding: "3px 8px", flexShrink: 0 }}>Copy</button>
            </div>
          ))}
          <button onClick={() => setEnrolResult(null)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px", marginTop: 6 }}>Dismiss</button>
        </div>
      )}
    </>
  );

  return (
    <div style={S.content}>
      {modal}
      <button onClick={onBack} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: 0, marginBottom: 12, fontFamily: "inherit" }}>← All clients</button>

      {/* Header — who, and the facts that matter */}
      <div style={{ ...S.card, padding: "18px 20px" }} data-testid="client-header">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
          <TypeIcon type={d.type} size={30} style={{ marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{d.name}</h1>
              <StatusBadge status={d.status} />
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
              {TYPE.label} · joined {fmtDate(d.created_at)} ·{" "}
              <span style={{ fontFamily: "monospace" }}>{d.id}</span>{" "}
              <button onClick={() => navigator.clipboard?.writeText(d.id)} style={{ background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 11, padding: 0 }}>copy</button>
            </div>
          </div>
          <button onClick={() => { setEditForm({ name: d.name ?? "", type: d.type ?? "", currency: d.currency ?? "" }); setEditing(true); }} style={{ ...S.btn, ...S.btnGhost }}>Edit details</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 16 }}>
          {fact("Web portal", hasWebHosting ? "Active" : "Not enabled", hasWebHosting ? "#34e5a0" : C.danger, () => setTab("billing"))}
          {fact("Plan", activeSub ? `${activeSub.plans?.name || "Active"} · to ${fmtDate(activeSub.expires_at)}` : "None", activeSub ? C.text : C.muted, () => setTab("billing"))}
          {fact("Branches", `${branches.length} · ${licensedCount} licensed`, C.text, () => setTab("branches"))}
          {fact("Tills", `${devices.length} enrolled`, C.text, () => setTab("branches"))}
          {fact("Desktop version", d.desktop_approved_version ? `v${d.desktop_approved_version}` : "Held", d.desktop_approved_version ? C.text : "#f59e0b", () => setTab("updates"))}
          {fact("Outstanding", fmt(outstanding), outstanding > 0 ? "#fbbf24" : C.text, () => setTab("billing"))}
        </div>
      </div>

      {error && <div style={{ marginBottom: 16, padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, color: C.danger, fontSize: 13 }}>{error}</div>}

      {d.status === "suspended" && (
        <div style={{ marginBottom: 16, padding: "12px 14px", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
          background: isPurgeDue(d) ? "rgba(245,158,11,0.08)" : "rgba(148,163,184,0.06)",
          border: `1px solid ${isPurgeDue(d) ? "rgba(245,158,11,0.35)" : C.border}` }}>
          <div style={{ fontSize: 12.5, flex: 1, minWidth: 220 }}>
            {d.suspended_at
              ? <>Suspended {daysSince(d.suspended_at)} days ago ({fmtDate(d.suspended_at)}).{isPurgeDue(d)
                  ? <b style={{ color: "#f59e0b" }}> Past the 6-month grace — normal user data is due for purge.</b>
                  : ` Normal user data purge-eligible in ${Math.max(0, PURGE_GRACE_DAYS - daysSince(d.suspended_at))} days. Financial/tax records are retained separately.`}</>
              : "Suspended (no timestamp recorded)."}
          </div>
          <button onClick={activate} style={{ ...S.btn, ...S.btnPrimary, fontSize: 12 }}>Activate</button>
          <button onClick={exportData} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>Export data</button>
          {isPurgeDue(d) && <button onClick={loadPurgePreview} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>Preview purge</button>}
        </div>
      )}

      {purgePreview && (
        <div style={{ ...S.card, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Purge preview — nothing is deleted</div>
            <button onClick={() => setPurgePreview(null)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "3px 8px" }}>Close</button>
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>{purgePreview.note}</div>
          {[
            { key: "purge",  label: "Would be DELETED (normal user data)", color: "#f59e0b" },
            { key: "review", label: "Needs accountant/DPO review before delete", color: "#a78bfa" },
            { key: "retain", label: "Retained (financial / tax / referenced)",  color: "#22c55e" },
          ].map(grp => (
            <div key={grp.key} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: grp.color, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{grp.label}</div>
              {(purgePreview[grp.key] || []).length === 0
                ? <div style={{ fontSize: 12, color: C.muted }}>— none —</div>
                : <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {purgePreview[grp.key].map(r => (
                      <span key={r.table} style={{ fontSize: 11, fontFamily: "monospace", color: C.text, background: "rgba(255,255,255,0.04)", border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px" }}>
                        {r.table} <b style={{ color: grp.color }}>{r.count}</b>
                      </span>
                    ))}
                  </div>}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div style={{ ...S.card, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Edit business</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={S.label}>Name</label>
              <input style={S.input} value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={S.label}>Type</label>
              <select style={S.input} value={editForm.type} onChange={e => setEditForm(f => ({ ...f, type: e.target.value }))}>
                {Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div style={{ width: 120 }}>
              <label style={S.label}>Currency</label>
              <input style={S.input} value={editForm.currency} onChange={e => setEditForm(f => ({ ...f, currency: e.target.value }))} placeholder="KES" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveEdit} style={{ ...S.btn, ...S.btnPrimary }}>Save</button>
            <button onClick={() => setEditing(false)} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="sp-tab-bar" data-testid="client-tabs">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...S.tab, ...(tab === k ? S.tabActive : {}) }}>{l}</button>
        ))}
      </div>

      {/* OVERVIEW — the business, its numbers, who supports it */}
      {tab === "overview" && (
        <div className="sp-two-col" style={{ alignItems: "start" }}>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Business profile</div>
            {[
              ["Type", TYPE.label],
              ["Currency", d.currency],
              ["VAT Rate", `${d.vat_rate}%`],
              ["Phone", d.phone || "—"],
              ["Email", d.email || "—"],
              ["Tax PIN", d.tax_pin || "—"],
              ["Address", d.address || "—"],
              ["Joined", fmtDate(d.created_at)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 12, color: C.muted, width: 90, flexShrink: 0 }}>{k}</span>
                <span style={{ fontSize: 12 }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 16 }}>
              {[
                ["Branches", d.branch_count ?? branches.length ?? 0, C.accent],
                ["Staff", d.staff_count ?? 0, "#a78bfa"],
                ["Products", d.product_count ?? 0, "#34d399"],
                ["Revenue this month", fmt(d.revenue_mtd, d.currency), "#fbbf24"],
              ].map(([l, v, c]) => (
                <div key={l} style={{ ...S.kpiCard }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{l}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: c }}>{v}</div>
                </div>
              ))}
            </div>
            <div style={S.card}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Support and sign-in</div>
              {/* 0.6.35 (A384): the tech allocated to this client — their number is on the shop's Help (till + web). */}
              <SupportTechPicker req={req} clientId={client.id} current={d.support_tech}
                onSaved={(tech) => setDetail(prev => ({ ...prev, support_admin_id: tech?.id ?? null, support_tech: tech }))} />
              {/* A378: the client's own sign-in address — their logo on the sign-in page; only their people sign in there. */}
              <div data-testid="signin-address" style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Sign-in address</div>
                {subDraft === null ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, fontFamily: "monospace", color: d.subdomain ? C.text : C.muted }}>
                      {d.sign_in_address || (d.subdomain ? `${d.subdomain}.<root domain>` : "None — signs in on the main address")}
                    </span>
                    <button onClick={() => { setSubDraft(d.subdomain || suggestSubdomain(d.name)); setSubError(""); }}
                            style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" }}>
                      {d.subdomain ? "Change" : "Set"}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <input style={{ ...S.input, width: 180 }} value={subDraft} autoFocus placeholder="e.g. africanfries"
                           onChange={e => { setSubDraft(e.target.value.toLowerCase()); setSubError(""); }} />
                    <span style={{ fontSize: 12, color: C.muted }}>.{d.tenant_root_domain || "<root domain>"}</span>
                    <button disabled={savingSub} onClick={saveSubdomain} style={{ ...S.btn, ...S.btnPrimary, fontSize: 11, padding: "5px 10px" }}>
                      {savingSub ? "…" : "Save"}
                    </button>
                    <button disabled={savingSub} onClick={() => { setSubDraft(null); setSubError(""); }}
                            style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" }}>Cancel</button>
                  </div>
                )}
                {subError && <div style={{ fontSize: 11, color: C.danger, marginTop: 6 }}>{subError}</div>}
                {d.subdomain && !d.tenant_root_domain && (
                  <div style={{ fontSize: 11, color: "#fbbf24", marginTop: 6 }}>
                    TENANT_ROOT_DOMAIN is not set on the cloud — the address is saved but not live yet.
                  </div>
                )}
                <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                  Leave empty and save to remove. Only this client's owner and staff can sign in on it.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* BRANCHES & TILLS — licences, enrolment codes, each branch's tills and their tech log */}
      {tab === "branches" && (
        <>
        <div style={S.card}>
          {!branchView ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Branches</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>A branch needs a desktop licence before its tills can be enrolled.</div>
                </div>
                <button onClick={() => { setBranchForm({ name: "", address: "", phone: "" }); setAddingBranch(v => !v); }} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 10px" }}>{addingBranch ? "Cancel" : "+ Add branch"}</button>
              </div>
              {addingBranch && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", margin: "8px 0 12px", flexWrap: "wrap", padding: "12px", background: "rgba(255,255,255,0.04)", border: `1px solid ${C.border}`, borderRadius: 10 }}>
                  <div style={{ flex: 1, minWidth: 140 }}><label style={S.label}>Name *</label><input style={S.input} value={branchForm.name} onChange={e => setBranchForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Westlands" autoFocus /></div>
                  <div style={{ flex: 1, minWidth: 120 }}><label style={S.label}>Address</label><input style={S.input} value={branchForm.address} onChange={e => setBranchForm(f => ({ ...f, address: e.target.value }))} /></div>
                  <div style={{ width: 130 }}><label style={S.label}>Phone</label><input style={S.input} value={branchForm.phone} onChange={e => setBranchForm(f => ({ ...f, phone: e.target.value }))} /></div>
                  <button onClick={createBranch} style={{ ...S.btn, ...S.btnPrimary, flexShrink: 0 }}>Create</button>
                </div>
              )}
              {branches.length === 0 && <p style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>No branches yet.</p>}
              {branches.map(b => {
                const tills = devices.filter(x => x.branchId === b.id);
                return (
                  <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 180, cursor: "pointer" }} onClick={() => openTills(b)}>
                      <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>{b.name}{b.is_main && <span style={{ fontSize: 10, color: C.accent, fontWeight: 600 }}>MAIN</span>}</div>
                      <div style={{ fontSize: 11, color: b.desktop_licensed ? "#34e5a0" : C.danger, marginTop: 2 }}>
                        {b.desktop_licensed ? `✓ Licensed${b.desktop_licensed_at ? ` ${new Date(b.desktop_licensed_at).toLocaleDateString("en-KE")}` : ""}` : "✗ Not licensed — desktop POS blocked"} · {tills.length} till{tills.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <StatusBadge status={b.status} />
                    <button onClick={() => openTills(b)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "5px 10px", flexShrink: 0 }}>Tills →</button>
                    {b.desktop_licensed && <button disabled={enrolBranch === b.id} onClick={() => generateEnrolCode(b)} title="Mint a single-use enrolment code for a till on this branch" style={{ ...S.btn, fontSize: 11, padding: "5px 10px", ...S.btnPrimary, flexShrink: 0 }}>{enrolBranch === b.id ? "…" : "Enrol till"}</button>}
                    <button disabled={licencingBranch === b.id} onClick={() => toggleBranchLicence(b, !b.desktop_licensed)} style={{ ...S.btn, fontSize: 11, padding: "5px 10px", ...(b.desktop_licensed ? S.btnDanger : S.btnPrimary), flexShrink: 0 }}>{licencingBranch === b.id ? "…" : b.desktop_licensed ? "Revoke licence" : "Activate licence"}</button>
                    {!b.is_main && <button disabled={closingBranch === b.id} onClick={() => toggleBranchStatus(b)} title={b.status === "inactive" ? "Reactivate this branch" : "Deactivate this branch"} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "5px 10px", flexShrink: 0 }}>{closingBranch === b.id ? "…" : b.status === "inactive" ? "Reopen" : "Close"}</button>}
                  </div>
                );
              })}
              {enrolPanel}
            </>
          ) : !deviceView ? (
            <>
              <button onClick={() => setBranchView(null)} style={{ ...S.btn, ...S.btnGhost, fontSize: 12, marginBottom: 12 }}>← Branches</button>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{branchView.name} — tills</div>
              {devices.filter(x => x.branchId === branchView.id).length === 0
                ? <p style={{ fontSize: 12, color: C.muted }}>No tills enrolled on this branch.</p>
                : devices.filter(x => x.branchId === branchView.id).map(dev => (
                    <div key={dev.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{dev.label}{dev.role && <span style={{ fontSize: 10, color: C.muted, marginLeft: 6, textTransform: "uppercase" }}>{dev.role}</span>}</div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{dev.lastSeenAt ? `seen ${new Date(dev.lastSeenAt).toLocaleDateString("en-KE")}` : "never seen"}{dev.appVersion ? ` · v${dev.appVersion}` : ""}{dev.status !== "approved" ? ` · ${dev.status}` : ""}</div>
                      </div>
                      <button onClick={() => openDeviceLog(dev)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "5px 10px", flexShrink: 0 }}>Tech log →</button>
                      <button onClick={() => revokeDevice(dev)} style={{ ...S.btn, ...S.btnDanger, fontSize: 11, padding: "5px 10px", flexShrink: 0 }}>Revoke</button>
                    </div>
                  ))}
            </>
          ) : (
            <>
              <button onClick={() => { setDeviceView(null); setTechAudit(null); }} style={{ ...S.btn, ...S.btnGhost, fontSize: 12, marginBottom: 12 }}>← Tills</button>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{deviceView.label} — tech audit log</div>
              {techAudit === null
                ? <p style={{ fontSize: 12, color: C.muted }}>Loading…</p>
                : techAudit.length === 0
                  ? <p style={{ fontSize: 12, color: C.muted }}>No tech actions logged on this till.</p>
                  : techAudit.map(e => (
                      <div key={e.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: 13 }}><b style={{ color: C.accent }}>{e.action}</b>{e.tech_name ? ` · ${e.tech_name}` : ""}</div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{new Date(e.occurred_at).toLocaleString("en-KE")}</div>
                        {e.detail && <pre style={{ fontSize: 10.5, color: C.muted, marginTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "monospace" }}>{typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}</pre>}
                      </div>
                    ))}
            </>
          )}
        </div>

        {/* A70: every enrolled till of this client, all branches */}
        {!branchView && (
          <div style={S.card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>All enrolled tills</div>
              <div style={{ fontSize: 11, color: C.muted }}>{devices.length} total</div>
            </div>
            {devices.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted, padding: "8px 0" }}>No tills enrolled yet.</div>
            ) : devices.map(dv => (
              <div key={dv.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {dv.label}
                    {dv.role && <span style={{ fontSize: 10, color: C.muted, marginLeft: 6, textTransform: "uppercase" }}>{dv.role}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{dv.branch}</div>
                </div>
                <div style={{ fontSize: 11, color: C.muted, textAlign: "right", flexShrink: 0 }}>
                  <div>{dv.lastSeenAt ? `seen ${new Date(dv.lastSeenAt).toLocaleDateString("en-KE")}` : "never seen"}</div>
                  <div style={{ marginTop: 2 }}>{dv.appVersion ? `v${dv.appVersion}` : "—"}{dv.status !== "approved" ? ` · ${dv.status}` : ""}</div>
                </div>
                <button onClick={() => revokeDevice(dv)} style={{ ...S.btn, ...S.btnDanger, fontSize: 10, padding: "4px 9px", flexShrink: 0 }}>Revoke</button>
              </div>
            ))}
          </div>
        )}
        </>
      )}

      {/* PLAN & BILLING — web access, the plan, invoices */}
      {tab === "billing" && (
        <>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Web portal access</div>
            {settingRow(
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {hasWebHosting ? <IconGlobe size={18} color="#22c55e" /> : <IconLock size={18} color={C.danger} />}
                Web portal {hasWebHosting ? "active" : "not enabled"}
              </span>,
              hasWebHosting
                ? "The client can use the cloud dashboard and the web POS."
                : "Desktop-only licence. Enabling web access (KES 10,000 a year) raises an invoice.",
              <button onClick={() => toggleWebHosting(!hasWebHosting)} style={{ ...S.btn, ...(hasWebHosting ? S.btnDanger : S.btnPrimary), fontSize: 12 }}>
                {hasWebHosting ? "Disable web access" : "Enable web access"}
              </button>,
              "web-access")}
            {/* A147: the date the renewal ladder is measured against */}
            {settingRow("Web access expiry",
              detail?.web_access_expires_at
                ? `Renewal is measured against ${fmtDate(detail.web_access_expires_at)}.`
                : "No expiry set — the renewal reminders have no date to measure against.",
              <>
                <input type="date" value={expiryDraft} onChange={e => setExpiryDraft(e.target.value)} style={{ ...S.input, width: "auto" }} />
                <button disabled={savingExpiry || !expiryDraft} onClick={() => setWebAccessExpiry(expiryDraft)}
                  style={{ ...S.btn, ...S.btnPrimary, fontSize: 12, opacity: (savingExpiry || !expiryDraft) ? 0.4 : 1 }}>
                  {savingExpiry ? "Saving…" : "Set expiry"}
                </button>
                {detail?.web_access_expires_at && (
                  <button disabled={savingExpiry} onClick={() => setWebAccessExpiry(null)} style={{ ...S.btn, ...S.btnGhost, fontSize: 12, opacity: savingExpiry ? 0.4 : 1 }}>Clear</button>
                )}
              </>)}
          </div>

          <div className="sp-two-col" style={{ alignItems: "start" }}>
            <div style={S.card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Current plan</div>
              {activeSub ? [
                ["Plan", activeSub.plans?.name || "—"],
                ["Status", <StatusBadge status={activeSub.status} />],
                ["Started", fmtDate(activeSub.starts_at)],
                ["Expires", fmtDate(activeSub.expires_at)],
                ["Price", fmt(activeSub.plans?.price)],
                ["Billing", activeSub.plans?.billing_cycle],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 12, color: C.muted, width: 80 }}>{k}</span>
                  <span style={{ fontSize: 13 }}>{v}</span>
                </div>
              )) : <div style={{ fontSize: 12, color: C.muted }}>No active plan.</div>}
            </div>
            <div style={S.card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Renew or change plan</div>
              <RenewForm plans={plans} clientId={client.id} req={req} onRenewed={() => req("GET", `/clients/${client.id}/subscription`).then(setSubs)} />
            </div>
          </div>

          <div className="sp-kpi-grid" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 16 }}>
            {[
              ["Total invoiced", fmt(invoices.reduce((s,i) => s + Number(i.amount), 0))],
              ["Paid",           fmt(invoices.filter(i => i.status === "paid").reduce((s,i) => s + Number(i.amount), 0))],
              ["Outstanding",    fmt(outstanding)],
            ].map(([l, v]) => (
              <div key={l} style={S.kpiCard}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{l}</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace" }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Invoices</div>
            {invoices.length === 0 ? <div style={{ fontSize: 12, color: C.muted }}>No invoices yet.</div> : (
            <div className="sp-table-wrap"><table style={S.table}>
              <thead><tr>{["Invoice #","Amount","Status","Created",""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {invoices.map(inv => (
                  <tr key={inv.id}>
                    <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12, color: C.accent }}>{inv.invoice_number}</td>
                    <td style={{ ...S.td, fontFamily: "monospace" }}>{fmt(inv.amount, inv.currency)}</td>
                    <td style={S.td}><StatusBadge status={inv.status} /></td>
                    <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{fmtDate(inv.created_at)}</td>
                    <td style={S.td}>
                      {inv.status !== "paid" && (
                        <button onClick={() => markPaid(inv.id)} style={{ ...S.btn, ...S.btnPrimary, fontSize: 11, padding: "4px 10px" }}>Mark paid</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            )}
          </div>
          {subs.length > 0 && (
            <div style={S.card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Plan history</div>
              <div className="sp-table-wrap"><table style={S.table}>
                <thead><tr>{["Plan","Status","Started","Expires"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {subs.map(s => (
                    <tr key={s.id}>
                      <td style={S.td}>{s.plans?.name || s.plan_id}</td>
                      <td style={S.td}><StatusBadge status={s.status} /></td>
                      <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{fmtDate(s.starts_at)}</td>
                      <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{fmtDate(s.expires_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* FEATURES — what the client's tills and web can do */}
      {tab === "features" && (
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Features</div>
          <p style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Changes take effect at once; tills pick them up at their next sync.</p>
          {/* A325: client branding Phase 2 — curated app themes (premium; off by default). */}
          {settingRow("App themes",
            hasThemes ? "The client picks an app theme on the Branding page; tills follow it." : "Tills keep the standard look. Turn on to let the client pick an app theme.",
            toggle(hasThemes, () => toggleThemes(!hasThemes), "App themes"))}
          {/* 0.6.27: the POS switches — always listed (off until set), named and explained. */}
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, margin: "18px 0 0", textTransform: "uppercase", letterSpacing: 0.4 }}>POS switches</div>
          {POS_FEATURES.map(pf => {
            const on = features.some(f => f.key === pf.key && f.enabled);
            return (
              <div key={pf.key} data-testid={`pos-feature-${pf.key}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{pf.label}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{pf.description}</div>
                </div>
                {toggle(on, () => toggleFeature(pf.key, !on), pf.label)}
              </div>
            );
          })}
          {features.filter(f => !POS_FEATURE_KEYS.includes(f.key) && f.key !== "themes" && f.key !== "web_hosting").length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, margin: "18px 0 4px", textTransform: "uppercase", letterSpacing: 0.4 }}>Other flags</div>
              {features.filter(f => !POS_FEATURE_KEYS.includes(f.key) && f.key !== "themes" && f.key !== "web_hosting").map(f => (
                <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, fontFamily: "monospace", color: C.accent }}>{f.key}</div>
                    {f.notes && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{f.notes}</div>}
                  </div>
                  {toggle(f.enabled, () => toggleFeature(f.key, !f.enabled), f.key)}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* DESKTOP UPDATES (A348) — per business, held by default */}
      {tab === "updates" && (
        <div style={S.card} data-testid="desktop-updates">
          <div style={{ fontSize: 13, fontWeight: 600 }}>Desktop updates</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
            {detail?.desktop_approved_version
              ? `Approved: ${detail.desktop_approved_version}. Tills on 0.6.16 or later update to it within the hour; it installs when each till is next closed.`
              : "Held — tills stay on the version they run. (Tills older than 0.6.16 still follow the published GitHub release.)"}
          </div>
          {desktopReleases && desktopReleases.error && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Could not list releases: {desktopReleases.error}</div>
          )}
          {desktopWarning && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{desktopWarning}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 14 }}>
            <select value={desktopPick} disabled={savingDesktop || !Array.isArray(desktopReleases)} onChange={e => setDesktopPick(e.target.value)}
              style={{ ...S.input, width: "auto" }}>
              <option value="">{desktopReleases === null ? "Loading releases…" : "Choose a version…"}</option>
              {Array.isArray(desktopReleases) && visibleVersions(desktopReleases, detail?.desktop_approved_version, showAllVersions).map(r => (
                <option key={r.version} value={r.version} disabled={!r.complete}>
                  {r.version}{r.draft ? " (draft)" : r.prerelease ? " (pre-release)" : ""}{r.complete ? "" : ` — missing ${r.missing.join(", ")}`}
                </option>
              ))}
            </select>
            <button disabled={savingDesktop || !desktopPick} onClick={() => setDesktopVersion(desktopPick)}
              style={{ ...S.btn, ...S.btnPrimary, fontSize: 12, opacity: (savingDesktop || !desktopPick) ? 0.4 : 1 }}>
              {savingDesktop ? "Saving…" : "Approve"}
            </button>
            {detail?.desktop_approved_version && (
              <button disabled={savingDesktop} onClick={() => setDesktopVersion(null)} style={{ ...S.btn, ...S.btnGhost, fontSize: 12, opacity: savingDesktop ? 0.4 : 1 }}>Hold</button>
            )}
            {Array.isArray(desktopReleases) && desktopReleases.length > RECENT_VERSIONS && (
              <button type="button" onClick={() => setShowAllVersions(v => !v)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 8px" }}>
                {showAllVersions ? `Show the latest ${RECENT_VERSIONS} only` : `Show all ${desktopReleases.length} versions`}
              </button>
            )}
          </div>
          {devices.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Tills now</div>
              {devices.map(dv => (
                <div key={dv.id} style={{ display: "flex", gap: 10, fontSize: 12, padding: "6px 0", borderTop: `1px solid ${C.border}` }}>
                  <span style={{ flex: 1 }}>{dv.label} <span style={{ color: C.muted }}>· {dv.branch}</span></span>
                  <span style={{ color: dv.appVersion && detail?.desktop_approved_version && dv.appVersion !== detail.desktop_approved_version ? "#f59e0b" : C.muted }}>{dv.appVersion ? `v${dv.appVersion}` : "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* OWNER & ACCOUNT — the owner's sign-in, and the account's status */}
      {tab === "account" && (
        <>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Owner sign-in</div>
            {settingRow("Login email", d.email || "—",
              <button onClick={changeOwnerEmail} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>Change email</button>)}
            {settingRow("Password", "Set a new password and give it to the owner securely; they can change it after signing in.",
              <button onClick={resetOwnerPassword} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>Reset password</button>)}
            {/* A391 */}
            {settingRow("Sign-in code", "The owner enters a code at every sign-in — emailed, or from their authenticator app. Lost phone? Reset to emailed codes.",
              <button onClick={resetOwnerOtp} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }} data-testid="reset-owner-otp">Reset to email code</button>,
              "owner-otp")}
          </div>
          <div style={{ ...S.card, borderColor: "rgba(255,92,108,0.3)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.danger, marginBottom: 6 }}>Account status</div>
            {d.status === "active"
              ? settingRow("Suspend this client", "Their owner and staff are locked out of the dashboard and web POS until you activate them again.",
                  <button onClick={suspend} style={{ ...S.btn, ...S.btnDanger, fontSize: 12 }}>Suspend</button>)
              : settingRow("Activate this client", "Their owner and staff can sign in again.",
                  <button onClick={activate} style={{ ...S.btn, ...S.btnPrimary, fontSize: 12 }}>Activate</button>)}
            {settingRow("Export data", "Download the client's data as JSON (before a purge, or on request).",
              <button onClick={exportData} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>Export</button>)}
          </div>
        </>
      )}

      {/* NOTES */}
      {tab === "notes" && (
        <div>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Add note</div>
            <textarea value={newNote} onChange={e => setNewNote(e.target.value)} rows={3}
              placeholder="Internal note about this client…"
              style={{ ...S.input, resize: "vertical", fontFamily: "inherit" }} />
            <button onClick={addNote} disabled={!newNote.trim()} style={{ ...S.btn, ...S.btnPrimary, marginTop: 10 }}>Add note</button>
          </div>
          {notes.map(n => (
            <div key={n.id} style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.accent }}>{n.admin_name}</span>
                <span style={{ fontSize: 11, color: C.muted }}>{timeAgo(n.created_at)}</span>
              </div>
              <p style={{ fontSize: 13, margin: 0, lineHeight: 1.6 }}>{n.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RenewForm({ plans, clientId, req, onRenewed }) {
  const [planId, setPlanId] = useState(plans[0]?.id || "");
  const [years, setYears]   = useState("1");
  const [ref, setRef]       = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone]     = useState(false);
  const [error, setError]   = useState("");

  async function submit() {
    setLoading(true); setError("");
    try {
      await req("POST", `/clients/${clientId}/subscription/renew`, { plan_id: planId, years: parseInt(years), payment_ref: ref || null });
      setDone(true); onRenewed();
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }

  if (done) return <p style={{ color: "#22c55e", fontSize: 13 }}>✓ Subscription renewed successfully.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 2 }}>
          <label style={S.label}>Plan</label>
          <select style={{ ...S.input }} value={planId} onChange={e => setPlanId(e.target.value)}>
            {plans.map(p => <option key={p.id} value={p.id}>{p.name} — {fmt(p.price)}/{p.billing_cycle}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={S.label}>Years</label>
          <select style={{ ...S.input }} value={years} onChange={e => setYears(e.target.value)}>
            <option value="1">1 year</option><option value="2">2 years</option><option value="3">3 years</option>
          </select>
        </div>
      </div>
      <div>
        <label style={S.label}>Payment Reference (optional)</label>
        <input style={S.input} value={ref} onChange={e => setRef(e.target.value)} placeholder="MPESA ref or bank ref" />
      </div>
      {error && <p style={{ color: "#ef4444", fontSize: 12, margin: 0 }}>{error}</p>}
      <button onClick={submit} disabled={!planId || loading} style={{ ...S.btn, ...S.btnPrimary }}>
        {loading ? "Processing…" : "Renew Subscription"}
      </button>
    </div>
  );
}

// ─── BILLING PAGE (all clients) ───────────────────────────────────────────────
function BillingPage({ req }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    // Fetch all businesses then get their invoices
    req("GET", "/clients?limit=200").then(async ({ clients }) => {
      const all = await Promise.all(
        clients.slice(0, 30).map(c =>
          req("GET", `/clients/${c.id}/billing`)
            .then(invs => invs.map(i => ({ ...i, business_name: c.name })))
            .catch(() => [])
        )
      );
      const flat = all.flat().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setInvoices(flat);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const total       = invoices.reduce((s, i) => s + Number(i.amount), 0);
  const paid        = invoices.filter(i => i.status === "paid").reduce((s, i) => s + Number(i.amount), 0);
  const outstanding = total - paid;

  return (
    <div style={S.content}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 20px" }}>Billing</h1>
      <div className="sp-kpi-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        {[["Total Invoiced", total, C.accent], ["Paid", paid, "#22c55e"], ["Outstanding", outstanding, "#f59e0b"]].map(([l, v, c]) => (
          <div key={l} style={S.kpiCard}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: c, fontFamily: "monospace" }}>{fmt(v)}</div>
          </div>
        ))}
      </div>
      {loading ? <div style={{ color: C.muted }}>Loading…</div> : (
        <div style={S.card}>
          <div className="sp-table-wrap"><table style={S.table}>
            <thead><tr>{["Invoice #","Client","Amount","Status","Date"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12, color: C.accent }}>{inv.invoice_number}</td>
                  <td style={{ ...S.td, fontSize: 13 }}>{inv.business_name}</td>
                  <td style={{ ...S.td, fontFamily: "monospace" }}>{fmt(inv.amount, inv.currency)}</td>
                  <td style={S.td}><StatusBadge status={inv.status} /></td>
                  <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{fmtDate(inv.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────
function AuditPage({ req }) {
  const [logs, setLogs]   = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    req("GET", "/audit?limit=100").then(d => { setLogs(d.logs); setTotal(d.total); })
      .catch(console.error).finally(() => setLoading(false));
  }, []);

  const ACTION_COLOR = (a) => {
    if (a.includes("suspend") || a.includes("disable")) return C.danger;
    if (a.includes("activate") || a.includes("enable")) return "#22c55e";
    if (a.includes("create") || a.includes("renew"))    return C.accent;
    return C.muted;
  };

  return (
    <div style={S.content}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 20px" }}>Audit Log</h1>
      {loading ? <div style={{ color: C.muted }}>Loading…</div> : (
        <div style={S.card}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>{total} total events</div>
          <div className="sp-table-wrap"><table style={S.table}>
            <thead><tr>{["When","Admin","Action","Client","Resource"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.id}>
                  <td style={{ ...S.td, color: C.muted, fontSize: 12, whiteSpace: "nowrap" }}>{timeAgo(l.event_time)}</td>
                  <td style={{ ...S.td, fontSize: 12 }}>{l.admin_email}</td>
                  <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12, color: ACTION_COLOR(l.action) }}>{l.action}</td>
                  <td style={{ ...S.td, fontSize: 12 }}>{l.business_name || "—"}</td>
                  <td style={{ ...S.td, fontSize: 12, color: C.muted }}>{l.resource || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TEAM ─────────────────────────────────────────────────────────────────────
function TeamPage({ req, admin }) {
  const [team, setTeam]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm]   = useState({ email: "", name: "", password: "", role: "agent", phone: "" });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    req("GET", "/team").then(setTeam).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);

  async function addMember(e) {
    e.preventDefault();
    setAdding(true); setError("");
    try {
      const m = await req("POST", "/team", form);
      setTeam(t => [...t, m]);
      setForm({ email: "", name: "", password: "", role: "agent", phone: "" });
    } catch(e) { setError(e.message); }
    finally { setAdding(false); }
  }

  // 0.6.35 (A384): a tech's number — shown on the Help of the clients they are allocated to.
  async function editPhone(m) {
    const raw = window.prompt(`Phone number for ${m.name} (e.g. 0712345678). Empty to remove.`, m.phone || "");
    if (raw === null) return;
    if (raw.trim() && !cleanPhone(raw)) { setError("Phone: use a Kenyan mobile number, e.g. 0712345678"); return; }
    setError("");
    try {
      const u = await req("PATCH", `/team/${m.id}`, { phone: raw.trim() || null });
      setTeam(t => t.map(x => x.id === m.id ? { ...x, phone: u.phone } : x));
    } catch (e) { setError(e.message); }
  }

  // A391: lost phone → back to emailed sign-in codes.
  async function resetOtp(m) {
    if (!window.confirm(`Reset ${m.name}'s sign-in code? They will get it by email at their next sign-in.`)) return;
    setError("");
    try {
      await req("POST", `/team/${m.id}/reset-otp`);
      setTeam(t => t.map(x => x.id === m.id ? { ...x, otp_method: "email" } : x));
    } catch (e) { setError(e.message); }
  }

  async function toggleActive(id, is_active) {
    await req("PATCH", `/team/${id}`, { is_active: !is_active });
    setTeam(t => t.map(m => m.id === id ? { ...m, is_active: !is_active } : m));
  }

  return (
    <div style={S.content}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 20px" }}>Admin Team</h1>
      <div className="sp-two-col" style={{ alignItems: "start", marginBottom: 0 }}>
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Team Members</div>
          {loading ? <div style={{ color: C.muted }}>Loading…</div> : (
            <div className="sp-table-wrap"><table style={S.table}>
              <thead><tr>{["Name","Email","Phone","Role","Sign-in code","Last login",""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {team.map(m => (
                  <tr key={m.id}>
                    <td style={{ ...S.td, fontWeight: 500 }}>{m.name}</td>
                    <td style={{ ...S.td, fontSize: 12, color: C.muted }}>{m.email}</td>
                    <td style={{ ...S.td, fontSize: 12 }}>
                      <button onClick={() => editPhone(m)} data-testid="team-phone"
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: m.phone ? C.text : C.muted, fontSize: 12 }}>
                        {m.phone ? displayPhone(m.phone) : "Add number"}
                      </button>
                    </td>
                    <td style={S.td}><span style={{ ...S.badge, background: m.role === "super_admin" ? "rgba(251,191,36,0.12)" : "rgba(0,212,255,0.12)", color: m.role === "super_admin" ? "#fbbf24" : C.accent }}>{m.role}</span></td>
                    <td style={{ ...S.td, fontSize: 12 }} data-testid="team-otp">
                      {m.otp_method === "totp" ? "Authenticator app" : "Email"}
                      {m.otp_method === "totp" && m.id !== admin?.id && (
                        <button onClick={() => resetOtp(m)} style={{ background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 11, marginLeft: 6 }}>reset</button>
                      )}
                    </td>
                    <td style={{ ...S.td, fontSize: 12, color: C.muted }}>{timeAgo(m.last_login_at)}</td>
                    <td style={S.td}>
                      {m.id !== admin?.id && (
                        <button onClick={() => toggleActive(m.id, m.is_active)}
                          style={{ ...S.btn, fontSize: 11, padding: "4px 10px", ...(m.is_active ? S.btnDanger : S.btnPrimary) }}>
                          {m.is_active ? "Deactivate" : "Activate"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Add Team Member</div>
          <form onSubmit={addMember} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[["Name","name","text"],["Email","email","email"],["Password","password","password"]].map(([l, k, t]) => (
              <div key={k}>
                <label style={S.label}>{l}</label>
                <input style={S.input} type={t} value={form[k]} required
                  onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
              </div>
            ))}
            <div>
              <label style={S.label}>Phone (shown to the shops they look after)</label>
              <input style={S.input} type="tel" value={form.phone} placeholder="0712345678"
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div>
              <label style={S.label}>Role</label>
              <select style={{ ...S.input }} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option value="agent">Agent</option>
                <option value="super_admin">Super Admin</option>
              </select>
            </div>
            {error && <div style={{ fontSize: 12, color: C.danger }}>{error}</div>}
            <button type="submit" disabled={adding} style={{ ...S.btn, ...S.btnPrimary }}>{adding ? "Adding…" : "Add Member"}</button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── MY ACCOUNT ───────────────────────────────────────────────────────────────
// A393: was "Settings". The sign-in code (A391) first, then the password; the server address under "Advanced".
function AccountPage({ req, apiUrl, setApiUrl }) {
  const [apiInput, setApiInput] = useState(apiUrl);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [current, setCurrent]   = useState("");
  const [newPw, setNewPw]       = useState("");
  const [confirm, setConfirm]   = useState("");
  const [pwMsg, setPwMsg]       = useState("");
  const [pwError, setPwError]   = useState("");

  async function changePw(e) {
    e.preventDefault(); setPwMsg(""); setPwError("");
    if (newPw !== confirm) { setPwError("Passwords do not match"); return; }
    try {
      await req("POST", "/auth/change-password", { current_password: current, new_password: newPw });
      setPwMsg("Password changed."); setCurrent(""); setNewPw(""); setConfirm("");
    } catch(e) { setPwError(e.message); }
  }

  return (
    <div style={S.content}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 4px" }}>My account</h1>
      <p style={{ fontSize: 13, color: C.muted, margin: "0 0 20px" }}>How you sign in to the admin portal.</p>
      <div className="sp-two-col" style={{ alignItems: "start", marginBottom: 0 }}>
        <SignInCodeCard req={req} />
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Change password</div>
          <form onSubmit={changePw} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {([["Current password", current, setCurrent], ["New password (8+ characters)", newPw, setNewPw], ["Confirm new password", confirm, setConfirm]] as [string, string, (v: string) => void][]).map(([l, v, s]) => (
              <div key={l}>
                <label style={S.label}>{l}</label>
                <input style={S.input} type="password" value={v} required onChange={e => s(e.target.value)} />
              </div>
            ))}
            {pwError && <div style={{ fontSize: 12, color: C.danger }}>{pwError}</div>}
            {pwMsg   && <div style={{ fontSize: 12, color: "#22c55e" }}>{pwMsg}</div>}
            <button type="submit" style={{ ...S.btn, ...S.btnPrimary }}>Change password</button>
          </form>
        </div>
      </div>
      <div style={S.card}>
        <button onClick={() => setShowAdvanced(v => !v)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: 0, fontFamily: "inherit" }}>
          {showAdvanced ? "▾" : "▸"} Advanced — server address
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 12, maxWidth: 420 }}>
            <label style={S.label}>ZapTill server address</label>
            <input style={S.input} value={apiInput} onChange={e => setApiInput(e.target.value)} />
            <button onClick={() => { setApiUrl(apiInput); saveApi(apiInput); }}
              style={{ ...S.btn, ...S.btnPrimary, marginTop: 12 }}>Save</button>
          </div>
        )}
      </div>
    </div>
  );
}


// ─── TECH ACCESS PAGE ─────────────────────────────────────────────────────────
function TechPage({ req, admin }) {
  const [clients, setClients]       = useState([]);
  const [tokens, setTokens]         = useState([]);
  const [switches, setSwitches]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [genForm, setGenForm]       = useState({ business_id: "", branch_id: "", branches: [] });
  const [switchForm, setSwitchForm] = useState({ business_id: "", branch_id: "", to_mode: "cloud", branches: [], currentMode: "" });
  const [generating, setGenerating] = useState(false);
  const [generatedToken, setGeneratedToken] = useState(null);
  const [revealCode, setRevealCode] = useState(null);   // D18: the branch doorknock code, shown with the token
  const [generatedSwitch, setGeneratedSwitch] = useState(null);
  const [error, setError]           = useState("");
  const { askConfirm, askPrompt, modal } = useModal();

  useEffect(() => {
    Promise.all([
      req("GET", "/clients?limit=200"),
      req("GET", "/tech/tokens?limit=30"),
      req("GET", "/mode-switch/requests"),
    ]).then(([c, t, s]) => {
      setClients(c.clients || []);
      setTokens(t || []);
      setSwitches(s || []);
    }).catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function loadBranches(businessId, formKey) {
    const br = await req("GET", `/clients/${businessId}/branches`).catch(() => []);
    if (formKey === "gen") setGenForm(f => ({ ...f, business_id: businessId, branch_id: "", branches: br }));
    else setSwitchForm(f => ({ ...f, business_id: businessId, branch_id: "", branches: br, currentMode: "" }));
  }

  async function generateToken(e) {
    e.preventDefault(); setGenerating(true); setError(""); setGeneratedToken(null); setRevealCode(null);
    try {
      const t = await req("POST", "/tech/generate-token", { business_id: genForm.business_id, branch_id: genForm.branch_id });
      setGeneratedToken(t);
      setTokens(prev => [{ ...t, id: t.token_id ?? t.id, admin_name: admin?.name, status: "active", created_at: new Date().toISOString() }, ...prev]);
      // D18: the till asks for the branch reveal code first. Show it beside the
      // token so the tech has both halves of the flow.
      req("GET", `/branches/${genForm.branch_id}/reveal-code`)
        .then(rc => setRevealCode(rc?.reveal_code ?? null))
        .catch(() => setRevealCode(null));
    } catch(e) { setError(e.message); }
    finally { setGenerating(false); }
  }

  // G3: rotate the branch reveal code (the A114 tech-access kill switch). The
  // endpoint existed but had no UI. Rotating invalidates the old doorknock; tills
  // pick up the new one on their next online sync.
  async function rotateRevealCode() {
    if (!genForm.branch_id) return;
    if (!(await askConfirm("Rotate this branch's reveal code? The current code stops working immediately; tills refresh the new one on their next online sync. Do this when a tech's access should end."))) return;
    try {
      const r = await req("POST", `/branches/${genForm.branch_id}/reveal-code/regenerate`, {});
      setRevealCode(r?.reveal_code ?? null);
    } catch (e) { setError(e?.message ?? "Failed to rotate reveal code"); }
  }

  async function generateSwitch(e) {
    e.preventDefault(); setGenerating(true); setError(""); setGeneratedSwitch(null);
    try {
      const s = await req("POST", "/mode-switch/generate", {
        business_id: switchForm.business_id,
        branch_id:   switchForm.branch_id,
        to_mode:     switchForm.to_mode,
      });
      setGeneratedSwitch(s);
      setSwitches(prev => [{ ...s, id: s.switch_id ?? s.token_id ?? s.id, status: "pending", created_at: new Date().toISOString() }, ...prev]);
    } catch(e) { setError(e.message); }
    finally { setGenerating(false); }
  }

  async function confirmToken(id) {
    await req("POST", `/tech/tokens/${id}/confirm`, {});
    setTokens(prev => prev.map(t => t.id === id ? { ...t, confirmed_at: new Date().toISOString() } : t));
  }

  async function revokeToken(id) {
    const reason = await askPrompt("Reason for revocation:");
    if (!reason) return;
    await req("POST", `/tech/tokens/${id}/revoke`, { reason });
    setTokens(prev => prev.map(t => t.id === id ? { ...t, status: "revoked" } : t));
  }

  async function cancelSwitch(id) {
    await req("POST", `/mode-switch/${id}/cancel`, {});
    setSwitches(prev => prev.map(s => s.id === id ? { ...s, status: "cancelled" } : s));
  }

  const pendingConfirmations = tokens.filter(t => t.status === "active" && !t.confirmed_at && new Date(t.expires_at) > new Date());

  if (loading) return <div style={{ padding: 24, color: C.muted }}>Loading…</div>;

  return (
    <div style={S.content}>
      {modal}
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 6px" }}>Tech Access</h1>
      <p style={{ fontSize: 13, color: C.muted, margin: "0 0 20px" }}>Manage tech credentials, offline access tokens, and deployment mode switches.</p>

      {error && <div style={{ marginBottom: 16, padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, color: C.danger, fontSize: 13 }}>{error}</div>}

      {/* Pending confirmation queue */}
      {pendingConfirmations.length > 0 && (
        <div style={{ marginBottom: 20, padding: "14px 18px", background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#fbbf24", marginBottom: 10 }}>
            ⚠️ {pendingConfirmations.length} access request{pendingConfirmations.length > 1 ? "s" : ""} awaiting confirmation
          </div>
          {pendingConfirmations.map(t => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: `1px solid rgba(251,191,36,0.1)` }}>
              <div style={{ flex: 1, fontSize: 12 }}>
                <span style={{ color: C.text, fontWeight: 500 }}>{t.admin_name}</span>
                <span style={{ color: C.muted }}> accessed </span>
                <span style={{ color: C.text, fontWeight: 500 }}>{t.branch_name}</span>
                <span style={{ color: C.muted }}> — expires {timeAgo(t.expires_at)}</span>
              </div>
              <button onClick={() => confirmToken(t.id)} style={{ ...S.btn, ...S.btnPrimary, fontSize: 11, padding: "4px 10px" }}>✓ Confirm</button>
              <button onClick={() => revokeToken(t.id)} style={{ ...S.btn, ...S.btnDanger, fontSize: 11, padding: "4px 10px" }}>Revoke</button>
            </div>
          ))}
        </div>
      )}

      <div className="sp-two-col">

        {/* Generate tech token */}
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Generate Tech Access Token</div>
          <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>48h offline token. Tech enters this on the client machine — no internet required on site.</p>
          <form onSubmit={generateToken} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={S.label}>Client</label>
              <select style={{ ...S.input }} value={genForm.business_id} required
                onChange={e => { setGenForm(f => ({ ...f, business_id: e.target.value, branch_id: "", branches: [] })); if (e.target.value) loadBranches(e.target.value, "gen"); }}>
                <option value="">Select client…</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {genForm.branches.length > 0 && (
              <div>
                <label style={S.label}>Branch</label>
                <select style={{ ...S.input }} value={genForm.branch_id} required onChange={e => setGenForm(f => ({ ...f, branch_id: e.target.value }))}>
                  <option value="">Select branch…</option>
                  {genForm.branches.map(b => <option key={b.id} value={b.id}>{b.name} {b.is_main ? "(main)" : ""}</option>)}
                </select>
              </div>
            )}
            <button type="submit" disabled={generating || !genForm.branch_id} style={{ ...S.btn, ...S.btnPrimary }}>
              {generating ? "Generating…" : "Generate Token"}
            </button>
          </form>
          {generatedToken && (
            <div style={{ marginTop: 14, padding: "12px 14px", background: "#0a1628", border: `1px solid ${C.accent}`, borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>TOKEN — share securely with tech. Shown once only.</div>
              {revealCode && (
                <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${C.accent}33` }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Reveal code — the tech enters this FIRST on the till.</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <code style={{ fontSize: 15, fontWeight: 700, letterSpacing: 2, color: C.accent }}>{revealCode}</code>
                    <button onClick={() => navigator.clipboard?.writeText(revealCode)} style={{ ...S.btn, ...S.btnGhost, fontSize: 10, padding: "3px 8px" }}>Copy</button>
                    <button onClick={rotateRevealCode} style={{ ...S.btn, ...S.btnGhost, fontSize: 10, padding: "3px 8px" }}>Rotate</button>
                  </div>
                </div>
              )}
              <code style={{ fontSize: 11, color: C.accent, wordBreak: "break-all", display: "block", marginBottom: 8 }}>{generatedToken.token}</code>
              <div style={{ fontSize: 11, color: C.muted }}>Valid for {generatedToken.branch} until {fmtDate(generatedToken.expires_at)}</div>
              <button onClick={() => navigator.clipboard?.writeText(generatedToken.token)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, marginTop: 8 }}>Copy token</button>
            </div>
          )}
        </div>

        {/* Generate mode switch token */}
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Generate Mode Switch Token</div>
          <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>7-day token for switching a branch between local and cloud. All orders migrate automatically — zero duplicates.</p>
          <form onSubmit={generateSwitch} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={S.label}>Client</label>
              <select style={{ ...S.input }} value={switchForm.business_id} required
                onChange={e => { setSwitchForm(f => ({ ...f, business_id: e.target.value, branch_id: "", branches: [], currentMode: "" })); if (e.target.value) loadBranches(e.target.value, "switch"); }}>
                <option value="">Select client…</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {switchForm.branches.length > 0 && (
              <div>
                <label style={S.label}>Branch</label>
                <select style={{ ...S.input }} value={switchForm.branch_id} required
                  onChange={e => {
                    const b = switchForm.branches.find(b => b.id === e.target.value);
                    setSwitchForm(f => ({ ...f, branch_id: e.target.value, currentMode: b?.deploy_mode || "cloud", to_mode: b?.deploy_mode === "cloud" ? "local" : "cloud" }));
                  }}>
                  <option value="">Select branch…</option>
                  {switchForm.branches.map(b => <option key={b.id} value={b.id}>{b.name} [{b.deploy_mode || "cloud"}]</option>)}
                </select>
              </div>
            )}
            {switchForm.branch_id && (
              <div>
                <label style={S.label}>Switch to</label>
                <select style={{ ...S.input }} value={switchForm.to_mode} onChange={e => setSwitchForm(f => ({ ...f, to_mode: e.target.value }))}>
                  <option value="cloud">Cloud (migrate local orders up)</option>
                  <option value="local">Local (download cloud orders to SQLite)</option>
                </select>
              </div>
            )}
            <button type="submit" disabled={generating || !switchForm.branch_id} style={{ ...S.btn, ...S.btnPrimary }}>
              {generating ? "Generating…" : "Generate Switch Token"}
            </button>
          </form>
          {generatedSwitch && (
            <div style={{ marginTop: 14, padding: "12px 14px", background: "#0a1628", border: `1px solid #22c55e`, borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>SWITCH TOKEN — give to tech verbally or via secure message.</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#22c55e", letterSpacing: "0.2em", textAlign: "center", padding: "10px 0" }}>{generatedSwitch.switch_token}</div>
              <div style={{ fontSize: 11, color: C.muted, textAlign: "center" }}>{generatedSwitch.from_mode} → {generatedSwitch.to_mode} · {generatedSwitch.branch} · expires {fmtDate(generatedSwitch.expires_at)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Recent tokens */}
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Recent Tech Access Tokens</div>
        <div className="sp-table-wrap"><table style={S.table}>
          <thead><tr>{["Tech","Client/Branch","Status","Created","Expires","Confirmed","Actions"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {tokens.length === 0 && <tr><td colSpan={7} style={{ ...S.td, color: C.muted, textAlign: "center", padding: 30 }}>No tokens yet</td></tr>}
            {tokens.map(t => (
              <tr key={t.id}>
                <td style={{ ...S.td, fontWeight: 500, fontSize: 12 }}>{t.admin_name}</td>
                <td style={{ ...S.td, fontSize: 12 }}>{t.businesses?.name && <span style={{ color: C.muted }}>{t.businesses.name} / </span>}{t.branch_name}</td>
                <td style={S.td}><StatusBadge status={t.status} /></td>
                <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{timeAgo(t.created_at)}</td>
                <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{timeAgo(t.expires_at)}</td>
                <td style={S.td}>
                  {t.confirmed_at
                    ? <span style={{ fontSize: 11, color: "#22c55e" }}>✓ {timeAgo(t.confirmed_at)}</span>
                    : t.status === "active"
                      ? <span style={{ fontSize: 11, color: "#fbbf24" }}>Pending</span>
                      : <span style={{ fontSize: 11, color: C.muted }}>—</span>
                  }
                </td>
                <td style={S.td}>
                  {t.status === "active" && !t.confirmed_at && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => confirmToken(t.id)} style={{ ...S.btn, ...S.btnPrimary, fontSize: 11, padding: "4px 8px" }}>Confirm</button>
                      <button onClick={() => revokeToken(t.id)} style={{ ...S.btn, ...S.btnDanger, fontSize: 11, padding: "4px 8px" }}>Revoke</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* Mode switch requests */}
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Mode Switch Requests</div>
        <div className="sp-table-wrap"><table style={S.table}>
          <thead><tr>{["Branch","Switch","Status","Orders Migrated","Generated","Expires",""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {switches.length === 0 && <tr><td colSpan={7} style={{ ...S.td, color: C.muted, textAlign: "center", padding: 30 }}>No mode switches yet</td></tr>}
            {switches.map(s => (
              <tr key={s.id}>
                <td style={{ ...S.td, fontSize: 12 }}>{s.branches?.name || s.branch_id}</td>
                <td style={{ ...S.td, fontSize: 12 }}>
                  <span style={{ color: C.muted }}>{s.from_mode}</span>
                  <span style={{ color: C.accent }}> → </span>
                  <span style={{ color: C.text, fontWeight: 500 }}>{s.to_mode}</span>
                </td>
                <td style={S.td}><StatusBadge status={s.status} /></td>
                <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{s.orders_migrated ?? "—"}</td>
                <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{timeAgo(s.created_at)}</td>
                <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{fmtDate(s.expires_at)}</td>
                <td style={S.td}>
                  {s.status === "pending" && (
                    <button onClick={() => cancelSwitch(s.id)} style={{ ...S.btn, ...S.btnDanger, fontSize: 11, padding: "4px 8px" }}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

// ─── NEW CLIENT ───────────────────────────────────────────────────────────────
function NewClientPage({ req, onCreated }) {
  const [form, setForm] = useState({
    businessName: "", businessType: "minimart", ownerName: "",
    ownerEmail: "", ownerPassword: "", phone: "",
    currency: "KES", vatRate: "16",
    branchName: "Main Branch", branchAddress: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [done, setDone]       = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    setError("");
    if ((form.ownerPassword || "").length < 8) {
      setError("Temporary password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      const result = await req("POST", "/clients", {
        ...form,
        vatRate: parseFloat(form.vatRate) || 16,
      });
      setDone(result);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }

  if (done) {
    return (
      <div style={S.content}>
        <div style={{ maxWidth: 540, margin: "0 auto" }}>
          <div style={{ ...S.card, borderColor: "rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.04)", textAlign: "center", padding: "40px 32px" }}>
            <div style={{ marginBottom: 16 }}><TypeIcon type={form.businessType} size={48} /></div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#22c55e", marginBottom: 8 }}>Client created!</div>
            <div style={{ fontSize: 14, color: C.muted, marginBottom: 24 }}>
              <strong style={{ color: C.text }}>{done.business.name}</strong> is ready to go.
            </div>
            <div style={{ background: "#0a1628", border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 20px", textAlign: "left", marginBottom: 24 }}>
              {[
                ["Business ID", done.business.id],
                ["Type", TYPE_META[done.business.type]?.label],
                ["Branch", done.branch.name],
                ["Owner login", form.ownerEmail],
                ["Temp password", form.ownerPassword],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 12, color: C.muted, width: 110, flexShrink: 0 }}>{k}</span>
                  <span style={{ fontSize: 12, fontFamily: "monospace", color: C.accent, wordBreak: "break-all" }}>{v}</span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12, color: "#f59e0b", marginBottom: 20 }}>
              ⚠ The owner will be prompted to change their password on first login.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => onCreated(done.business)} style={{ ...S.btn, ...S.btnPrimary, flex: 1 }}>
                View client →
              </button>
              <button onClick={() => { setDone(null); setForm({ businessName: "", businessType: "minimart", ownerName: "", ownerEmail: "", ownerPassword: "", phone: "", currency: "KES", vatRate: "16", branchName: "Main Branch", branchAddress: "" }); }} style={{ ...S.btn, ...S.btnGhost, flex: 1 }}>
                + Add another
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.content}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>New Client</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: "4px 0 0" }}>Create a new business account. A trial subscription is automatically applied.</p>
      </div>

      <div style={{ maxWidth: 680 }}>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Business type picker */}
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Business Type</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 8 }}>
              {Object.entries(TYPE_META).map(([val, meta]) => (
                <button
                  key={val} type="button"
                  onClick={() => set("businessType", val)}
                  style={{
                    padding: "12px 10px", borderRadius: 10, border: `1px solid`,
                    borderColor: form.businessType === val ? meta.color : C.border,
                    background: form.businessType === val ? `${meta.color}18` : "transparent",
                    cursor: "pointer", display: "flex", flexDirection: "column",
                    alignItems: "center", gap: 6, transition: "all 0.15s",
                  }}>
                  <TypeIcon type={val} size={22} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: form.businessType === val ? meta.color : C.muted }}>{meta.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Business details */}
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Business Details</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={S.label}>Business Name *</label>
                <input style={S.input} required value={form.businessName}
                  onChange={e => set("businessName", e.target.value)} placeholder="e.g. Lovers Rock Minimart" />
              </div>
              <div>
                <label style={S.label}>Phone</label>
                <input style={S.input} value={form.phone}
                  onChange={e => set("phone", e.target.value)} placeholder="+254 7XX XXX XXX" />
              </div>
              <div>
                <label style={S.label}>Currency</label>
                <select style={S.input} value={form.currency} onChange={e => set("currency", e.target.value)}>
                  {["KES","USD","UGX","TZS","ETB","GHS","NGN","ZAR"].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>VAT Rate (%)</label>
                <input style={S.input} type="number" min="0" max="30" step="0.5"
                  value={form.vatRate} onChange={e => set("vatRate", e.target.value)} />
              </div>
            </div>
          </div>

          {/* Branch */}
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Main Branch</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={S.label}>Branch Name *</label>
                <input style={S.input} required value={form.branchName}
                  onChange={e => set("branchName", e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Address</label>
                <input style={S.input} value={form.branchAddress}
                  onChange={e => set("branchAddress", e.target.value)} placeholder="e.g. Kisumu Mall, Ground Floor" />
              </div>
            </div>
          </div>

          {/* Owner account */}
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Owner Login Account</div>
            <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
              A Supabase auth account is created with these credentials. The owner logs in at <code style={{ color: C.accent }}>/login</code>.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={S.label}>Owner Name</label>
                <input style={S.input} value={form.ownerName}
                  onChange={e => set("ownerName", e.target.value)} placeholder="Full name" />
              </div>
              <div>
                <label style={S.label}>Email *</label>
                <input style={S.input} type="email" required value={form.ownerEmail}
                  onChange={e => set("ownerEmail", e.target.value)} placeholder="owner@business.com" />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={S.label}>Temporary Password * (min 8 chars)</label>
                <input
                  style={{ ...S.input, ...(form.ownerPassword && form.ownerPassword.length < 8 ? { borderColor: "#ef4444" } : {}) }}
                  value={form.ownerPassword}
                  onChange={e => set("ownerPassword", e.target.value)}
                  placeholder="At least 8 characters — they must change it on first login" />
                {form.ownerPassword && form.ownerPassword.length < 8 && (
                  <p style={{ fontSize: 11, color: "#ef4444", marginTop: 6 }}>Must be at least 8 characters.</p>
                )}
                <p style={{ fontSize: 11, color: "#f59e0b", marginTop: 6 }}>
                  ⚠ Owner will be forced to change password on first login.
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, color: C.danger, fontSize: 13 }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={{ ...S.btn, ...S.btnPrimary, padding: "13px", fontSize: 14 }}>
            {loading ? "Creating client…" : `Create ${TYPE_META[form.businessType]?.label || "Business"}`}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function AdminPortal() {
  const { req, token, setToken, apiUrl, setApiUrl } = useAdminApi();
  const [admin, setAdmin]     = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(KEY.user) || "null"); } catch { return null; }
  });
  const [page, setPage]       = useState("dashboard");
  const [selectedClient, setSelectedClient] = useState(null);
  // Must be declared before any early return below, or the hook count changes
  // between the logged-out and logged-in render → React #310 (blank screen on
  // login). All hooks must run on every render.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const critical = useCriticalCount(req, Boolean(token && admin));   // A392: the number on Alerts

  function handleLogin(tok, adminData) {
    setToken(tok);
    setAdmin(adminData);
    sessionStorage.setItem(KEY.user, JSON.stringify(adminData));
    setPage("dashboard");
  }

  function handleLogout() {
    setToken("");
    setAdmin(null);
    sessionStorage.removeItem(KEY.token);
    sessionStorage.removeItem(KEY.user);
  }

  function handleSelectClient(client) {
    setSelectedClient(client);
    setPage("client_detail");
  }

  if (!token || !admin) {
    return <LoginPage onLogin={handleLogin} apiUrl={apiUrl} setApiUrl={setApiUrl} req={req} />;
  }

  const pageEl = (() => {
    if (page === "client_detail" && selectedClient)
      return <ClientDetailPage client={selectedClient} req={req} onBack={() => setPage("clients")} />;
    if (page === "new_client") return <NewClientPage req={req} onCreated={(biz) => { setSelectedClient(biz); setPage("client_detail"); }} />;
    if (page === "clients")   return <ClientsPage req={req} onSelectClient={handleSelectClient} />;
    if (page === "billing")   return <BillingPage req={req} />;
    if (page === "audit")     return <AuditPage req={req} />;
    if (page === "team")      return <TeamPage req={req} admin={admin} />;
    if (page === "account")   return <AccountPage req={req} apiUrl={apiUrl} setApiUrl={setApiUrl} />;
    if (page === "alerts")    return <AlertsPage req={req} isSuper={admin?.role === "super_admin"} />;
    if (page === "tech")      return <TechPage req={req} admin={admin} />;
    if (page === "migrations") return <MigrationsPage req={(p: string) => req("GET", p, undefined)} />;
    return <DashboardPage req={req} onOpenAlerts={() => setPage("alerts")} onSelectClient={handleSelectClient} />;
  })();

  return (
    <div style={{ display: "flex", fontFamily: "'DM Sans', system-ui, sans-serif", background: C.bg, minHeight: "100vh", width: "100vw", overflow: "hidden" }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { width: 100%; height: 100%; }

        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        select option { background: #0d1526; }

        /* ── Sidebar: desktop always visible, mobile hidden by default ── */
        .sp-sidebar {
          transform: translateX(0);
        }
        .sp-hamburger { display: none; }
        .sp-email-label { display: inline; }
        .sp-main-wrap {
          margin-left: ${SIDEBAR_W}px;
          width: calc(100vw - ${SIDEBAR_W}px);
          display: flex;
          flex-direction: column;
          min-height: 100vh;
          min-width: 0;
        }
        .sp-content-scroll {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
        }
        /* KPI grid — 5 cols desktop */
        .sp-kpi-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 14px;
          margin-bottom: 20px;
        }
        /* Two column grid */
        .sp-two-col {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 20px;
        }
        /* Tech page two col */
        .sp-two-col-form {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 20px;
          align-items: start;
        }
        /* Tables — horizontal scroll on small screens */
        .sp-table-wrap {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
        }
        /* Tab bar scroll */
        .sp-tab-bar {
          display: flex;
          border-bottom: 1px solid ${C.border};
          margin-bottom: 20px;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
        }
        .sp-tab-bar::-webkit-scrollbar { height: 0; }

        /* ── Tablet: 768–1100px ── */
        @media (max-width: 1100px) {
          .sp-kpi-grid { grid-template-columns: repeat(3, 1fr); }
        }
        @media (max-width: 900px) {
          .sp-two-col { grid-template-columns: 1fr; }
          .sp-two-col-form { grid-template-columns: 1fr; }
          .sp-kpi-grid { grid-template-columns: repeat(2, 1fr); }
        }

        /* ── Mobile: < 768px ── */
        @media (max-width: 767px) {
          .sp-sidebar {
            transform: translateX(-100%);
          }
          .sp-sidebar.sp-sidebar-open {
            transform: translateX(0) !important;
          }
          .sp-mobile-backdrop {
            display: block !important;
          }
          .sp-close-btn {
            display: block !important;
          }
          .sp-hamburger {
            display: flex !important;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            background: transparent;
            border: 1px solid ${C.border};
            border-radius: 8px;
            color: ${C.muted};
            cursor: pointer;
            font-size: 18px;
            flex-shrink: 0;
          }
          .sp-main-wrap {
            margin-left: 0 !important;
            width: 100vw !important;
          }
          .sp-email-label { display: none; }
          .sp-kpi-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
          .sp-content-scroll { padding: 0; }
        }

        @media (max-width: 480px) {
          .sp-kpi-grid { grid-template-columns: 1fr 1fr; }
        }
      `}</style>

      <Sidebar
        page={page}
        setPage={p => { setPage(p); setSelectedClient(null); }}
        admin={admin}
        onLogout={handleLogout}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        critical={critical}
      />

      <div className="sp-main-wrap">
        {/* Topbar */}
        <div style={{ ...S.topbar, position: "sticky", top: 0, zIndex: 50 }}>
          {/* Hamburger — mobile only */}
          <button className="sp-hamburger" onClick={() => setSidebarOpen(s => !s)}>☰</button>

          <span style={{ fontSize: 14, fontWeight: 600, color: C.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {page === "client_detail" ? selectedClient?.name
              : NAV_GROUPS.flatMap(g => g.items).find(n => n.id === page)?.label ?? "Dashboard"}
          </span>

          <span className="sp-email-label" style={{ fontSize: 12, color: C.muted, flexShrink: 0, whiteSpace: "nowrap" }}>
            Logged in as <strong style={{ color: C.text }}>{admin.email}</strong>
          </span>
        </div>

        {/* Scrollable content */}
        <div className="sp-content-scroll" style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          {pageEl}
        </div>
      </div>
    </div>
  );
}
