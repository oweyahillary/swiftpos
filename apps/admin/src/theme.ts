import type { CSSProperties } from "react";

// ─── Design tokens ────────────────────────────────────────────────────────────
export const C = {
  bg:       "#070b14",
  surface:  "rgba(15,23,40,0.55)",     // dark glass — sidebar / topbar / modal
  card:     "rgba(255,255,255,0.045)", // frosted glass — cards / panels
  border:   "rgba(255,255,255,0.09)",  // glass edge (top-highlight)
  accent:   "#38e1ff",
  violet:   "#a78bfa",
  green:    "#34e5a0",
  text:     "#e8eef7",
  muted:    "#8ea0bd",
  danger:   "#ff5c6c",
};

export const SIDEBAR_W = 220;

export const S: Record<string, CSSProperties> = {
  // Sidebar — CSS class handles responsive visibility
  sidebar: { width: SIDEBAR_W, background: C.surface, backdropFilter: "blur(20px) saturate(150%)", WebkitBackdropFilter: "blur(20px) saturate(150%)", borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0, height: "100vh", position: "fixed", top: 0, left: 0, zIndex: 100, transition: "transform 0.25s ease" },
  // Main — CSS class handles the responsive margin
  main:    { minHeight: "100vh", background: "transparent", color: C.text, display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden" },
  topbar:  { height: 52, background: C.surface, backdropFilter: "blur(20px) saturate(150%)", WebkitBackdropFilter: "blur(20px) saturate(150%)", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 20px", gap: 12, flexShrink: 0 },
  content: { padding: "24px", flex: 1 },
  card:    { background: C.card, backdropFilter: "blur(22px) saturate(150%)", WebkitBackdropFilter: "blur(22px) saturate(150%)", border: `1px solid ${C.border}`, borderRadius: 18, padding: "16px 20px", marginBottom: 16, boxShadow: "0 10px 34px rgba(2,6,16,0.35), inset 0 1px 0 rgba(255,255,255,0.05)" },
  kpiCard: { background: C.card, backdropFilter: "blur(22px) saturate(150%)", WebkitBackdropFilter: "blur(22px) saturate(150%)", border: `1px solid ${C.border}`, borderRadius: 18, padding: "20px 24px", flex: 1, minWidth: 0, boxShadow: "0 10px 34px rgba(2,6,16,0.35), inset 0 1px 0 rgba(255,255,255,0.05)" },
  btn:     { padding: "8px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none", fontFamily: "inherit", flexShrink: 0 },
  btnPrimary: { background: C.accent, color: "#04121a" },
  btnGhost:   { background: "rgba(255,255,255,0.05)", color: C.muted, border: `1px solid ${C.border}` },
  btnDanger:  { background: "rgba(255,92,108,0.12)", color: C.danger, border: `1px solid rgba(255,92,108,0.3)` },
  input:   { background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, borderRadius: 10, padding: "9px 12px", color: C.text, fontSize: 13, outline: "none", width: "100%", fontFamily: "inherit", boxSizing: "border-box" },
  label:   { fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 },
  badge:   { fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600 },
  table:   { width: "100%", borderCollapse: "collapse", minWidth: 600 },
  th:      { padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${C.border}`, background: "rgba(255,255,255,0.03)", whiteSpace: "nowrap" },
  td:      { padding: "12px 14px", fontSize: 13, borderBottom: `1px solid ${C.border}` },
  tab:     { padding: "8px 16px", fontSize: 13, background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", color: C.muted, borderBottom: "2px solid transparent", whiteSpace: "nowrap" },
  tabActive: { color: C.accent, borderBottom: `2px solid ${C.accent}` },
};
