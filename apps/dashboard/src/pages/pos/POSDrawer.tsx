/**
 * POSDrawer — the web POS's "Menu": the back-office screens a person may open from the till.
 *
 * A490: built from the permission catalogue's FINE keys (lib/permissions.ts) — one rule with the rest of the web
 * (hasPermission on the session's expanded map). Only screens that exist are listed; a key without a screen here
 * (e.g. menu.edit, staff.roles) is used where it applies, never as a "not built yet" placeholder. Each screen's words
 * come from the catalogue (PERMISSIONS label / description), not a private list.
 *
 *   Reports    → POSReportsTab       (the reports it shows: POS_REPORT_KEYS — each report by its own key)
 *   Orders     → POSOrderHistoryTab  (orders.view_all)
 *   Stock      → POSInventoryTab     (inventory.view)
 *   Customers  → POSCustomersTab     (customers.view)
 */

import { useEffect, useState, useCallback } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';
import ReleaseBadge from '../../components/ReleaseBadge';
import POSReportsTab, { POS_REPORT_KEYS } from './POSReportsTab';
import POSOrderHistoryTab  from './POSOrderHistoryTab';
import POSInventoryTab     from './POSInventoryTab';
import POSCustomersTab     from './POSCustomersTab';
import { PERMISSIONS, PERMISSION_GROUPS, hasAnyPermission } from '../../lib/permissions';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currency: string;
}

// ── The screens ───────────────────────────────────────────────────────────────

type ScreenProps = { currency: string };

/** Each screen, keyed by the permission that opens it ('reports' = any of the reports it shows). */
const SCREENS: Record<string, React.ComponentType<ScreenProps>> = {
  'reports':         ({ currency }) => <POSReportsTab currency={currency} />,
  'orders.view_all': ({ currency }) => <POSOrderHistoryTab currency={currency} />,
  'inventory.view':  ()             => <POSInventoryTab />,
  'customers.view':  ({ currency }) => <POSCustomersTab currency={currency} />,
};

/** Rail order, icon and the short rail word; the heading and its line come from the catalogue. */
const SCREEN_ORDER: Array<{ id: keyof typeof SCREENS & string; icon: string; rail: string; keys: readonly string[] }> = [
  { id: 'reports',         icon: '📊', rail: 'Reports',   keys: POS_REPORT_KEYS },
  { id: 'orders.view_all', icon: '🧾', rail: 'Orders',    keys: ['orders.view_all'] },
  { id: 'inventory.view',  icon: '📦', rail: 'Stock',     keys: ['inventory.view'] },
  { id: 'customers.view',  icon: '👥', rail: 'Customers', keys: ['customers.view'] },
];

const catalogueLabel = (key: string) => PERMISSIONS.find((p) => p.key === key);
const reportsGroup = PERMISSION_GROUPS.find((g) => g.id === 'reports');

/** The heading and line shown above a screen — the catalogue's own words. */
function screenWords(id: string): { title: string; line: string } {
  if (id === 'reports') return { title: reportsGroup?.label ?? 'Reports', line: reportsGroup?.description ?? '' };
  const p = catalogueLabel(id);
  return { title: p?.label ?? id, line: p?.description ?? '' };
}

/** The screens this person may open, in rail order. */
export function drawerScreens(held: ReadonlySet<string>): string[] {
  return SCREEN_ORDER.filter((sc) => hasAnyPermission(held, sc.keys)).map((sc) => sc.id);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function POSDrawer({ isOpen, onClose, currency }: Props) {
  const { session, posApi, held } = usePOSAuth();

  const screens = drawerScreens(held);
  const [active, setActive] = useState<string | null>(screens[0] ?? null);

  // Re-sync on session change (a refreshed permission map, re-login)
  useEffect(() => {
    const list = drawerScreens(held);
    setActive((cur) => (cur && list.includes(cur) ? cur : list[0] ?? null));
  }, [held]);

  // Keyboard close
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && isOpen) onClose();
  }, [isOpen, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll lock
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ ...s.backdrop, opacity: isOpen ? 1 : 0, pointerEvents: isOpen ? 'auto' : 'none' }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div style={{ ...s.drawer, transform: isOpen ? 'translateX(0)' : 'translateX(100%)' }}>

        {/* Header */}
        <div style={s.header}>
          <div style={s.headerLeft}>
            <span style={s.headerIcon}>⚡</span>
            <div>
              <p style={s.headerTitle}>POS Menu</p>
              <p style={s.headerSub}>{session?.staffName} · {session?.role}</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Empty state */}
        {screens.length === 0 && (
          <div style={s.empty}>
            <p style={{ fontSize: 36, margin: '0 0 12px' }}>🔒</p>
            <p style={s.emptyText}>Nothing else has been given to your role.</p>
          </div>
        )}

        {/* Two-column layout */}
        {screens.length > 0 && (
          <div style={s.body}>

            {/* Left rail — one tab per screen */}
            <nav style={s.rail}>
              {SCREEN_ORDER.filter(sc => screens.includes(sc.id)).map(sc => (
                <button
                  key={sc.id}
                  data-testid={`drawer-${sc.id}`}
                  style={{ ...s.railTab, ...(active === sc.id ? s.railTabActive : {}) }}
                  onClick={() => setActive(sc.id)}
                  title={screenWords(sc.id).title}
                >
                  <span style={s.railIcon}>{sc.icon}</span>
                  <span style={s.railLabel}>{sc.rail}</span>
                </button>
              ))}
            </nav>

            {/* Right area */}
            <div style={s.main}>
              {active && (
                <div style={s.subHead}>
                  <p style={s.subTitle}>{screenWords(active).title}</p>
                  {screenWords(active).line && <p style={s.subLine}>{screenWords(active).line}</p>}
                </div>
              )}
              <div style={s.content}>
                {active && (() => {
                  const Screen = SCREENS[active];
                  return Screen ? <Screen currency={currency} /> : null;
                })()}
              </div>
            </div>

          </div>
        )}
        {/* 0.6.28: which release this website and the cloud run */}
        <div style={{ padding: '8px 16px', borderTop: '1px solid #334155', flexShrink: 0 }}>
          <ReleaseBadge getCloud={() => posApi.get('/api/version')} />
        </div>
      </div>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
    zIndex: 70, transition: 'opacity 0.25s ease',
  },
  drawer: {
    position: 'fixed', top: 0, right: 0, bottom: 0,
    width: 460, maxWidth: '96vw',
    background: '#1e293b', borderLeft: '1px solid #334155',
    zIndex: 71, display: 'flex', flexDirection: 'column',
    transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
    boxShadow: '-8px 0 40px rgba(0,0,0,0.5)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 16px', borderBottom: '1px solid #334155', flexShrink: 0,
  },
  headerLeft:  { display: 'flex', alignItems: 'center', gap: 10 },
  headerIcon:  { fontSize: 20 },
  headerTitle: { margin: 0, fontSize: 14, fontWeight: 700, color: '#f1f5f9' },
  headerSub:   { margin: 0, fontSize: 11, color: '#64748b' },
  closeBtn: {
    background: '#334155', border: 'none', borderRadius: 8, color: '#94a3b8',
    fontSize: 14, width: 30, height: 30, display: 'flex', alignItems: 'center',
    justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
  },
  empty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  emptyText: { fontSize: 13, color: '#475569', textAlign: 'center' as const, lineHeight: 1.6, maxWidth: 220 },
  body:   { flex: 1, display: 'flex', overflow: 'hidden' },

  // Left rail
  rail: {
    width: 80, flexShrink: 0, background: '#0f172a', borderRight: '1px solid #1e293b',
    display: 'flex', flexDirection: 'column', padding: '6px 0',
    gap: 2, overflowY: 'auto' as const,
  },
  railTab: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '10px 4px', background: 'transparent', border: 'none',
    borderLeft: '3px solid transparent', color: '#475569', cursor: 'pointer',
    fontSize: 9, fontWeight: 600, textTransform: 'uppercase' as const,
    letterSpacing: '0.4px', textAlign: 'center' as const, transition: 'all 0.15s ease',
  },
  // A609: the active marker in the owner's SECONDARY colour when one is chosen (index.css --act-accent), else as before.
  railTabActive: {
    color: '#93c5fd', borderLeftColor: 'rgb(var(--act-accent, var(--act-fill, 59 130 246)))', background: 'rgb(var(--act-fill, 59 130 246) / 0.08)',
  },
  railIcon:  { fontSize: 20 },
  railLabel: { lineHeight: 1.2, width: 68, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },

  // Right main
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },

  // The screen's heading (the catalogue's words)
  subHead:  { padding: '10px 16px 8px', borderBottom: '1px solid #334155', flexShrink: 0 },
  subTitle: { margin: 0, fontSize: 13, fontWeight: 700, color: '#f1f5f9' },
  subLine:  { margin: '2px 0 0', fontSize: 11, color: '#64748b', lineHeight: 1.5 },

  // Content
  content: { flex: 1, overflowY: 'auto' as const, padding: '14px 16px 24px' },
};
