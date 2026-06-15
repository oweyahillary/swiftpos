import { useState, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";


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

// ─── API layer ────────────────────────────────────────────────────────────────
// ─── API hook ─────────────────────────────────────────────────────────────────
function useAdminApi() {
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem("swiftpos_admin_api") || import.meta.env.VITE_API_URL || DEFAULT_API);
  const [token, setToken]   = useState(() => sessionStorage.getItem("swiftpos_admin_token") || "");

  const req = useCallback(async (method, path, body) => {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/admin${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
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

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:       "#0a0e17",
  surface:  "#111827",
  card:     "#1a2234",
  border:   "#1e2d45",
  accent:   "#00d4ff",
  green:    "#00ff88",
  text:     "#e2e8f0",
  muted:    "#64748b",
  danger:   "#ef4444",
};

const SIDEBAR_W = 220;

const S = {
  // Sidebar — CSS class handles responsive visibility
  sidebar: { width: SIDEBAR_W, background: C.surface, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0, height: "100vh", position: "fixed", top: 0, left: 0, zIndex: 100, transition: "transform 0.25s ease" },
  // Main — CSS class handles the responsive margin
  main:    { minHeight: "100vh", background: C.bg, color: C.text, display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden" },
  topbar:  { height: 52, background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 20px", gap: 12, flexShrink: 0 },
  content: { padding: "24px", flex: 1 },
  card:    { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px", marginBottom: 16 },
  kpiCard: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", flex: 1, minWidth: 0 },
  btn:     { padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none", fontFamily: "inherit", flexShrink: 0 },
  btnPrimary: { background: C.accent, color: "#0a0e17" },
  btnGhost:   { background: "transparent", color: C.muted, border: `1px solid ${C.border}` },
  btnDanger:  { background: "rgba(239,68,68,0.1)", color: C.danger, border: `1px solid rgba(239,68,68,0.3)` },
  input:   { background: "#0f1929", border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", color: C.text, fontSize: 13, outline: "none", width: "100%", fontFamily: "inherit", boxSizing: "border-box" },
  label:   { fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 },
  badge:   { fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600 },
  table:   { width: "100%", borderCollapse: "collapse", minWidth: 600 },
  th:      { padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${C.border}`, background: "#0f1929", whiteSpace: "nowrap" },
  td:      { padding: "12px 14px", fontSize: 13, borderBottom: `1px solid ${C.border}` },
  tab:     { padding: "8px 16px", fontSize: 13, background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", color: C.muted, borderBottom: "2px solid transparent", whiteSpace: "nowrap" },
  tabActive: { color: C.accent, borderBottom: `2px solid ${C.accent}` },
};


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
  const [email, setEmail]     = useState("admin@swiftpos.co.ke");
  const [password, setPass]   = useState("");
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [apiInput, setApiInput] = useState(apiUrl);

  async function submit(e) {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const { token, admin } = await req("POST", "/auth/login", { email, password });
      sessionStorage.setItem("swiftpos_admin_token", token);
      onLogin(token, admin);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 380, padding: 40, background: C.surface, borderRadius: 16, border: `1px solid ${C.border}` }}>
        <div style={{ marginBottom: 32, textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", color: C.accent }}>SwiftPOS</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>Admin Command Centre</div>
        </div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={S.label}>Email</label>
            <input style={S.input} type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={S.label}>Password</label>
            <input style={S.input} type="password" value={password} onChange={e => setPass(e.target.value)} />
          </div>
          {error && <div style={{ fontSize: 12, color: C.danger, padding: "8px 12px", background: "rgba(239,68,68,0.08)", borderRadius: 6 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ ...S.btn, ...S.btnPrimary, padding: "11px", marginTop: 4 }}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <button onClick={() => setShowApi(s => !s)} style={{ ...S.btn, ...S.btnGhost, width: "100%", marginTop: 12, fontSize: 11 }}>
          {showApi ? "Hide" : "⚙ Change API URL"}
        </button>
        {showApi && (
          <div style={{ marginTop: 10 }}>
            <input style={S.input} value={apiInput} onChange={e => setApiInput(e.target.value)} placeholder="http://localhost:4000" />
            <button onClick={() => { setApiUrl(apiInput); localStorage.setItem("swiftpos_admin_api", apiInput); }}
              style={{ ...S.btn, ...S.btnPrimary, width: "100%", marginTop: 8 }}>Save API URL</button>
          </div>
        )}
        <p style={{ textAlign: "center", fontSize: 11, color: C.muted, marginTop: 16 }}>Default: admin@swiftpos.co.ke / SwiftAdmin2026!</p>
      </div>
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function Sidebar({ page, setPage, admin, onLogout, isOpen, onClose }) {
  const nav = [
    { id: "dashboard", icon: "▦", label: "Dashboard" },
    { id: "clients",   icon: "◈", label: "Clients" },
    { id: "billing",   icon: "◉", label: "Billing" },
    { id: "audit",     icon: "≡", label: "Audit Log" },
    { id: "team",      icon: "◎", label: "Team", superOnly: true },
    { id: "tech",      icon: "⌘", label: "Tech Access" },
    { id: "settings",  icon: "⊙", label: "Settings" },
  ];

  function navigate(id) {
    setPage(id);
    onClose?.(); // close mobile drawer on nav
  }

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
            <div style={{ fontSize: 18, fontWeight: 800, color: C.accent, letterSpacing: "-0.01em" }}>SwiftPOS</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Admin Portal</div>
          </div>
          {/* Close button — mobile only */}
          <button onClick={onClose} className="sp-close-btn"
            style={{ background: "transparent", border: "none", color: C.muted, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 4, display: "none" }}>
            ✕
          </button>
        </div>
        <nav style={{ flex: 1, padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
          {nav.filter(n => !n.superOnly || admin?.role === "super_admin").map(n => (
            <button key={n.id} onClick={() => navigate(n.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 8, fontSize: 13, fontWeight: 500, border: "none", cursor: "pointer", textAlign: "left", background: page === n.id ? "rgba(0,212,255,0.08)" : "transparent", color: page === n.id ? C.accent : C.muted, fontFamily: "inherit", transition: "all 0.15s", width: "100%" }}>
              <span style={{ fontSize: 15, width: 20, textAlign: "center", flexShrink: 0 }}>{n.icon}</span>
              {n.label}
            </button>
          ))}
          <button onClick={() => navigate("new_client")}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 8, fontSize: 13, fontWeight: 500, border: `1px dashed ${C.border}`, cursor: "pointer", textAlign: "left", background: "transparent", color: C.muted, fontFamily: "inherit", marginTop: 8, width: "100%" }}>
            <span style={{ fontSize: 15, width: 20, textAlign: "center", flexShrink: 0 }}>+</span>
            New Client
          </button>
        </nav>
        <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, color: C.text, fontWeight: 600, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{admin?.name || "Admin"}</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{admin?.email}</div>
          <button onClick={onLogout} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "6px 12px", width: "100%" }}>Sign out</button>
        </div>
      </aside>
    </>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function DashboardPage({ req }) {
  const [stats, setStats]   = useState(null);
  const [health, setHealth] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([req("GET", "/fleet/stats"), req("GET", "/fleet/health")])
      .then(([s, h]) => { setStats(s); setHealth(h); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 24, color: C.muted }}>Loading fleet data…</div>;

  const typeBreakdown = Object.entries(
    health.reduce((acc, b) => { acc[b.type] = (acc[b.type] || 0) + 1; return acc; }, {})
  ).map(([type, count]) => ({ type: TYPE_META[type]?.label || type, count }));

  const critical    = health.filter(b => b.health_score < 40).length;
  const needsAttn   = health.filter(b => b.health_score >= 40 && b.health_score < 70).length;
  const healthy     = health.filter(b => b.health_score >= 70).length;

  return (
    <div style={S.content}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Fleet Dashboard</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: "4px 0 0" }}>SwiftPOS client overview</p>
      </div>

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
            <div style={{ fontSize: k.mono ? 18 : 28, fontWeight: 700, color: k.color, fontFamily: k.mono ? "monospace" : "inherit" }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="sp-two-col">
        {/* Health breakdown */}
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Fleet Health</div>
          <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
            {[["Healthy", healthy, "#22c55e"], ["Attention", needsAttn, "#f59e0b"], ["Critical", critical, C.danger]].map(([l, v, c]) => (
              <div key={l} style={{ textAlign: "center", flex: 1 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: c }}>{v}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{l}</div>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={typeBreakdown} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="type" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 10 }} />
              <Tooltip contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8 }} />
              <Bar dataKey="count" fill={C.accent} radius={[4,4,0,0]} />
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
              <tr key={b.id} style={{ cursor: "pointer" }}>
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
                <td style={S.td}><StatusBadge status={b.status} /></td>
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
  const [loading, setLoading] = useState(true);
  const [newNote, setNewNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      req("GET", `/clients/${client.id}`),
      req("GET", `/clients/${client.id}/features`),
      req("GET", `/clients/${client.id}/subscription`),
      req("GET", `/clients/${client.id}/billing`),
      req("GET", `/clients/${client.id}/notes`),
      req("GET", "/plans"),
      req("GET", `/clients/${client.id}/branches`).catch(() => []),
    ]).then(([d, f, s, inv, n, p, br]) => {
      setDetail(d); setFeatures(f); setSubs(s); setInvoices(inv); setNotes(n); setPlans(p);
      setBranches(br || []);
    }).catch(e => setError(e.message))
      .finally(() => setLoading(false));
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
    const reason = prompt("Reason for suspension:");
    if (!reason) return;
    await req("POST", `/clients/${client.id}/suspend`, { reason });
    setDetail(d => ({ ...d, status: "suspended" }));
  }

  async function activate() {
    await req("POST", `/clients/${client.id}/activate`, {});
    setDetail(d => ({ ...d, status: "active" }));
  }

  async function addNote() {
    if (!newNote.trim()) return;
    const n = await req("POST", `/clients/${client.id}/notes`, { body: newNote });
    setNotes(prev => [n, ...prev]);
    setNewNote("");
  }

  async function markPaid(invoiceId) {
    const ref = prompt("Payment reference (optional):");
    await req("PATCH", `/clients/${client.id}/billing/${invoiceId}`, { status: "paid", payment_reference: ref || null });
    setInvoices(prev => prev.map(i => i.id === invoiceId ? { ...i, status: "paid", payment_reference: ref } : i));
  }


  const webHostingFlag = features.find(f => f.key === 'web_hosting');
  const hasWebHosting  = webHostingFlag?.enabled === true;

  async function toggleWebHosting(enable) {
    const confirmMsg = enable
      ? 'Enable web portal access? This will allow the client to log into the dashboard. Ensure payment of KES 10,000 has been received.'
      : 'Disable web portal access? The client will be locked out of the dashboard immediately.';
    if (!window.confirm(confirmMsg)) return;

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

  async function toggleBranchLicence(branch, licensed) {
    const price = licensed ? prompt(`One-off desktop licence fee for "${branch.name}" (KES). Leave blank to create invoice later:`) : null;
    const ref   = licensed && price ? prompt("Payment reference (M-Pesa ref / bank ref):") : null;
    if (licensed && price === null) return; // user cancelled

    setLicencingBranch(branch.id);
    try {
      await req("POST", `/clients/${client.id}/branches/${branch.id}/licence`, {
        licensed,
        invoice_amount: price ? parseInt(price) : null,
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

  if (loading) return <div style={{ padding: 24, color: C.muted }}>Loading client…</div>;

  const d = detail || client;
  const activeSub = subs.find(s => s.status === "active");
  const TYPE = TYPE_META[d.type] || TYPE_META.other;

  const TABS = ["overview", "features", "subscription", "billing", "notes"];

  return (
    <div style={S.content}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <button onClick={onBack} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>← Back</button>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 24 }}>{TYPE.icon}</span>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{d.name}</h1>
            <StatusBadge status={d.status} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, fontFamily: "monospace", marginTop: 2 }}>{d.id}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {d.status === "active"
            ? <button onClick={suspend} style={{ ...S.btn, ...S.btnDanger }}>Suspend</button>
            : <button onClick={activate} style={{ ...S.btn, ...S.btnPrimary }}>Activate</button>
          }
        </div>
      </div>

      {error && <div style={{ marginBottom: 16, padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, color: C.danger, fontSize: 13 }}>{error}</div>}


      {/* ── Web Hosting status banner ── */}
      <div style={{ marginBottom: 16, padding: "14px 18px", background: hasWebHosting ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)", border: `1px solid ${hasWebHosting ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`, borderRadius: 10, display: "flex", alignItems: "center", gap: 14 }}>
        {hasWebHosting ? <IconGlobe size={22} color="#22c55e" /> : <IconLock size={22} color={C.danger} />}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: hasWebHosting ? "#22c55e" : C.danger }}>
            Web portal {hasWebHosting ? "ACTIVE" : "NOT ENABLED"}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            {hasWebHosting
              ? "Client can access the cloud dashboard and web POS."
              : "Client is on desktop-only licence. Upgrade required (KES 10,000) for web portal access."}
          </div>
        </div>
        <button
          onClick={() => toggleWebHosting(!hasWebHosting)}
          style={{ ...S.btn, ...(hasWebHosting ? S.btnDanger : S.btnPrimary), fontSize: 12 }}>
          {hasWebHosting ? "Disable web access" : "Enable web access"}
        </button>
      </div>

      {/* Tab bar */}
      <div className="sp-tab-bar">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ ...S.tab, ...(tab === t ? S.tabActive : {}), textTransform: "capitalize" }}>
            {t}
          </button>
        ))}
      </div>

      {/* OVERVIEW */}
      {tab === "overview" && (
        <div className="sp-two-col" style={{ marginBottom: 0 }}>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Business Profile</div>
            {[
              ["Type", `${TYPE.icon} ${TYPE.label}`],
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
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 12 }}>
              {[
                ["Branches", d.branch_count ?? d.branches?.length ?? 0, C.accent],
                ["Staff", d.staff_count ?? 0, "#a78bfa"],
                ["Products", d.product_count ?? 0, "#34d399"],
              ].map(([l, v, c]) => (
                <div key={l} style={{ ...S.kpiCard, flex: 1 }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{l}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: c }}>{v}</div>
                </div>
              ))}
            </div>
            <div style={S.card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Revenue MTD</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#fbbf24", fontFamily: "monospace" }}>{fmt(d.revenue_mtd, d.currency)}</div>
            </div>
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Branch Licences</div>
                <span style={{ fontSize: 11, color: C.muted }}>Desktop = one-off per branch</span>
              </div>
              {branches.length === 0 && <p style={{ fontSize: 12, color: C.muted }}>No branches yet.</p>}
              {branches.map(b => (
                <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                      {b.name}
                      {b.is_main && <span style={{ fontSize: 10, color: C.accent, fontWeight: 600 }}>MAIN</span>}
                    </div>
                    {b.desktop_licensed
                      ? <div style={{ fontSize: 11, color: "#22c55e", marginTop: 2 }}>✓ Desktop licensed — {b.desktop_licensed_at ? new Date(b.desktop_licensed_at).toLocaleDateString("en-KE") : ""}</div>
                      : <div style={{ fontSize: 11, color: C.danger, marginTop: 2 }}>✗ Not licensed — desktop POS blocked</div>
                    }
                  </div>
                  <StatusBadge status={b.status} />
                  <button
                    disabled={licencingBranch === b.id}
                    onClick={() => toggleBranchLicence(b, !b.desktop_licensed)}
                    style={{ ...S.btn, fontSize: 11, padding: "5px 10px", ...(b.desktop_licensed ? S.btnDanger : S.btnPrimary), flexShrink: 0 }}>
                    {licencingBranch === b.id ? "…" : b.desktop_licensed ? "Revoke" : "Activate"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* FEATURES */}
      {tab === "features" && (
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Feature Flags</div>
          <p style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>Toggle features on/off for this client. Changes take effect immediately.</p>
          {features.length === 0 && <p style={{ color: C.muted, fontSize: 13 }}>No feature flags configured yet.</p>}
          {features.map(f => (
            <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, fontFamily: "monospace", color: C.accent }}>{f.key}</div>
                {f.notes && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{f.notes}</div>}
              </div>
              <button onClick={() => toggleFeature(f.key, !f.enabled)}
                style={{ width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer", background: f.enabled ? "#22c55e" : C.border, position: "relative", transition: "background 0.2s" }}>
                <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: f.enabled ? 23 : 3, transition: "left 0.2s" }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* SUBSCRIPTION */}
      {tab === "subscription" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {activeSub && (
            <div style={S.card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Current Subscription</div>
              {[
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
              ))}
            </div>
          )}
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Renew / Upgrade</div>
            <RenewForm plans={plans} clientId={client.id} req={req} onRenewed={() => req("GET", `/clients/${client.id}/subscription`).then(setSubs)} />
          </div>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Subscription History</div>
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
        </div>
      )}

      {/* BILLING */}
      {tab === "billing" && (
        <div>
          <div className="sp-kpi-grid" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 16 }}>
            {[
              ["Total Invoiced", fmt(invoices.reduce((s,i) => s + Number(i.amount), 0))],
              ["Paid",           fmt(invoices.filter(i => i.status === "paid").reduce((s,i) => s + Number(i.amount), 0))],
              ["Outstanding",   fmt(invoices.filter(i => i.status !== "paid").reduce((s,i) => s + Number(i.amount), 0))],
            ].map(([l, v]) => (
              <div key={l} style={S.kpiCard}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{l}</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace" }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Invoices</div>
            <div className="sp-table-wrap"><table style={S.table}>
              <thead><tr>{["Invoice #","Amount","Status","Created","Actions"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {invoices.map(inv => (
                  <tr key={inv.id}>
                    <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12, color: C.accent }}>{inv.invoice_number}</td>
                    <td style={{ ...S.td, fontFamily: "monospace" }}>{fmt(inv.amount, inv.currency)}</td>
                    <td style={S.td}><StatusBadge status={inv.status} /></td>
                    <td style={{ ...S.td, color: C.muted, fontSize: 12 }}>{fmtDate(inv.created_at)}</td>
                    <td style={S.td}>
                      {inv.status !== "paid" && (
                        <button onClick={() => markPaid(inv.id)} style={{ ...S.btn, ...S.btnPrimary, fontSize: 11, padding: "4px 10px" }}>Mark Paid</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      )}

      {/* NOTES */}
      {tab === "notes" && (
        <div>
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Add Note</div>
            <textarea value={newNote} onChange={e => setNewNote(e.target.value)} rows={3}
              placeholder="Internal note about this client…"
              style={{ ...S.input, resize: "vertical", fontFamily: "inherit" }} />
            <button onClick={addNote} disabled={!newNote.trim()} style={{ ...S.btn, ...S.btnPrimary, marginTop: 10 }}>Add Note</button>
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

  async function submit() {
    setLoading(true);
    try {
      await req("POST", `/clients/${clientId}/subscription/renew`, { plan_id: planId, years: parseInt(years), payment_ref: ref || null });
      setDone(true); onRenewed();
    } catch(e) { alert(e.message); }
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
      const flat = all.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
  const [form, setForm]   = useState({ email: "", name: "", password: "", role: "agent" });
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
      setForm({ email: "", name: "", password: "", role: "agent" });
    } catch(e) { setError(e.message); }
    finally { setAdding(false); }
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
              <thead><tr>{["Name","Email","Role","Last Login","Active"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {team.map(m => (
                  <tr key={m.id}>
                    <td style={{ ...S.td, fontWeight: 500 }}>{m.name}</td>
                    <td style={{ ...S.td, fontSize: 12, color: C.muted }}>{m.email}</td>
                    <td style={S.td}><span style={{ ...S.badge, background: m.role === "super_admin" ? "rgba(251,191,36,0.12)" : "rgba(0,212,255,0.12)", color: m.role === "super_admin" ? "#fbbf24" : C.accent }}>{m.role}</span></td>
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

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function SettingsPage({ req, apiUrl, setApiUrl }) {
  const [apiInput, setApiInput] = useState(apiUrl);
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
      setPwMsg("Password changed successfully."); setCurrent(""); setNewPw(""); setConfirm("");
    } catch(e) { setPwError(e.message); }
  }

  return (
    <div style={S.content}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 20px" }}>Settings</h1>
      <div className="sp-two-col" style={{ alignItems: "start", marginBottom: 0 }}>
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>API Connection</div>
          <label style={S.label}>SwiftPOS Server URL</label>
          <input style={S.input} value={apiInput} onChange={e => setApiInput(e.target.value)} />
          <button onClick={() => { setApiUrl(apiInput); localStorage.setItem("swiftpos_admin_api", apiInput); }}
            style={{ ...S.btn, ...S.btnPrimary, marginTop: 12 }}>Save</button>
        </div>
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Change Password</div>
          <form onSubmit={changePw} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[["Current password", current, setCurrent], ["New password", newPw, setNewPw], ["Confirm new password", confirm, setConfirm]].map(([l, v, s]) => (
              <div key={l}>
                <label style={S.label}>{l}</label>
                <input style={S.input} type="password" value={v} required onChange={e => s(e.target.value)} />
              </div>
            ))}
            {pwError && <div style={{ fontSize: 12, color: C.danger }}>{pwError}</div>}
            {pwMsg   && <div style={{ fontSize: 12, color: "#22c55e" }}>{pwMsg}</div>}
            <button type="submit" style={{ ...S.btn, ...S.btnPrimary }}>Change Password</button>
          </form>
        </div>
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
  const [generatedSwitch, setGeneratedSwitch] = useState(null);
  const [error, setError]           = useState("");

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
    e.preventDefault(); setGenerating(true); setError(""); setGeneratedToken(null);
    try {
      const t = await req("POST", "/tech/generate-token", { business_id: genForm.business_id, branch_id: genForm.branch_id });
      setGeneratedToken(t);
      setTokens(prev => [{ ...t, admin_name: admin?.name, status: "active", created_at: new Date().toISOString() }, ...prev]);
    } catch(e) { setError(e.message); }
    finally { setGenerating(false); }
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
      setSwitches(prev => [{ ...s, status: "pending", created_at: new Date().toISOString() }, ...prev]);
    } catch(e) { setError(e.message); }
    finally { setGenerating(false); }
  }

  async function confirmToken(id) {
    await req("POST", `/tech/tokens/${id}/confirm`, {});
    setTokens(prev => prev.map(t => t.id === id ? { ...t, confirmed_at: new Date().toISOString() } : t));
  }

  async function revokeToken(id) {
    const reason = prompt("Reason for revocation:");
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
    setError(""); setLoading(true);
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
                  <span style={{ fontSize: 22 }}>{meta.icon}</span>
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
                <input style={S.input} required minLength={8} value={form.ownerPassword}
                  onChange={e => set("ownerPassword", e.target.value)}
                  placeholder="They must change this on first login" />
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
    try { return JSON.parse(sessionStorage.getItem("swiftpos_admin_user") || "null"); } catch { return null; }
  });
  const [page, setPage]       = useState("dashboard");
  const [selectedClient, setSelectedClient] = useState(null);

  function handleLogin(tok, adminData) {
    setToken(tok);
    setAdmin(adminData);
    sessionStorage.setItem("swiftpos_admin_user", JSON.stringify(adminData));
    setPage("dashboard");
  }

  function handleLogout() {
    setToken("");
    setAdmin(null);
    sessionStorage.removeItem("swiftpos_admin_token");
    sessionStorage.removeItem("swiftpos_admin_user");
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
    if (page === "settings")  return <SettingsPage req={req} apiUrl={apiUrl} setApiUrl={setApiUrl} />;
    if (page === "tech")      return <TechPage req={req} admin={admin} />;
    return <DashboardPage req={req} />;
  })();

  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div style={{ display: "flex", fontFamily: "'DM Sans', system-ui, sans-serif", background: C.bg, minHeight: "100vh", width: "100vw", overflow: "hidden" }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { width: 100%; height: 100%; }

        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        select option { background: ${C.surface}; }

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
      />

      <div className="sp-main-wrap">
        {/* Topbar */}
        <div style={{ ...S.topbar, position: "sticky", top: 0, zIndex: 50 }}>
          {/* Hamburger — mobile only */}
          <button className="sp-hamburger" onClick={() => setSidebarOpen(s => !s)}>☰</button>

          <span style={{ fontSize: 14, fontWeight: 600, color: C.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {page === "client_detail" ? selectedClient?.name : page.charAt(0).toUpperCase() + page.slice(1).replace(/_/g, " ")}
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
