/**
 * POSDrawer — Dynamic Permission-Driven Navigation
 *
 * Nav is built entirely from session.permissions (Record<string, boolean>),
 * which is the effective permission map stored in the cashier JWT at login.
 *
 * Algorithm:
 *   1. Take all keys where value === true
 *   2. Derive module from key prefix  (e.g. "reports.view" → "reports")
 *   3. Group by module — skip modules with zero granted keys
 *   4. Each module becomes a left-rail tab; each key within it becomes a sub-tab
 *   5. Active key renders its rich component if one is registered,
 *      otherwise falls back to GenericPermissionView
 *
 * Adding a new permission to the DB and granting it to a role automatically
 * produces a working tab with the generic fallback — zero code changes here.
 *
 * To promote a key to a rich view: add one entry to RICH_COMPONENTS below.
 */

import { useEffect, useState, useCallback } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';
import POSReportsTab       from './POSReportsTab';
import POSOrderHistoryTab  from './POSOrderHistoryTab';
import POSInventoryTab     from './POSInventoryTab';
import POSCustomersTab     from './POSCustomersTab';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currency: string;
}

// ── Module metadata ───────────────────────────────────────────────────────────
// Display name + icon for known module prefixes.
// Unknown prefixes auto-capitalise and get a generic key icon.

const MODULE_META: Record<string, { label: string; icon: string }> = {
  reports:   { label: 'Reports',   icon: '📊' },
  orders:    { label: 'Orders',    icon: '🧾' },
  inventory: { label: 'Inventory', icon: '📦' },
  customers: { label: 'Customers', icon: '👥' },
  products:  { label: 'Products',  icon: '🛒' },
  payments:  { label: 'Payments',  icon: '💳' },
  discounts: { label: 'Discounts', icon: '🏷️' },
  staff:     { label: 'Staff',     icon: '👤' },
  settings:  { label: 'Settings',  icon: '⚙️' },
  expenses:  { label: 'Expenses',  icon: '💸' },
  kitchen:   { label: 'Kitchen',   icon: '🍳' },
};

// ── Permission key labels ─────────────────────────────────────────────────────
// Human-readable sub-tab labels for known keys.
// Unknown keys auto-format from the key itself.

const KEY_LABELS: Record<string, string> = {
  'orders.create':    'Create Orders',
  'orders.view_all':  'Order History',
  'orders.void':      'Void Orders',
  'orders.refund':    'Process Refunds',
  'orders.hold':      'Hold Orders',
  'products.view':    'View Products',
  'products.manage':  'Manage Products',
  'inventory.view':   'Stock Levels',
  'inventory.adjust': 'Adjust Stock',
  'reports.view':     'Sales Report',
  'reports.export':   'Export Reports',
  'staff.manage':     'Manage Staff',
  'settings.manage':  'Settings',
  'discounts.apply':  'Apply Discounts',
  'discounts.manage': 'Manage Discounts',
  'customers.view':   'View Customers',
  'customers.manage': 'Manage Customers',
  'payments.cash':    'Cash Payments',
  'payments.mpesa':   'M-Pesa Payments',
  'payments.card':    'Card Payments',
  'expenses.view':    'View Expenses',
  'expenses.manage':  'Manage Expenses',
  'kitchen.view':     'Kitchen Display',
  'kitchen.manage':   'Manage Kitchen',
};

// ── Rich component registry ───────────────────────────────────────────────────
// Maps specific permission keys → purpose-built components.
// Any key NOT listed here gets GenericPermissionView automatically.
// To promote a key: add one line here. No other changes required.

type RichProps = { currency: string; permissionKey: string };

const RICH_COMPONENTS: Record<string, React.ComponentType<RichProps>> = {
  'reports.view':    ({ currency }) => <POSReportsTab currency={currency} />,
  'orders.view_all': ({ currency }) => <POSOrderHistoryTab currency={currency} />,
  'inventory.view':  ()             => <POSInventoryTab />,
  'customers.view':  ({ currency }) => <POSCustomersTab currency={currency} />,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveModule(key: string): string {
  return key.split('.')[0] ?? key;
}

function getModuleMeta(prefix: string) {
  return MODULE_META[prefix] ?? {
    label: prefix.charAt(0).toUpperCase() + prefix.slice(1),
    icon: '🔑',
  };
}

function getKeyLabel(key: string): string {
  return (
    KEY_LABELS[key] ??
    key.split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' › ')
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ModuleGroup {
  prefix: string;
  label:  string;
  icon:   string;
  keys:   string[];
}

// ── All known permission keys (source of truth for wildcard expansion) ────────
// Must stay in sync with the permissions table in the DB.
// Order within each module controls sub-tab order.

const ALL_KNOWN_KEYS: string[] = [
  'reports.view', 'reports.export',
  'orders.view_all', 'orders.void', 'orders.refund', 'orders.hold', 'orders.create',
  'inventory.view', 'inventory.adjust',
  'customers.view', 'customers.manage',
  'products.view', 'products.manage',
  'payments.cash', 'payments.mpesa', 'payments.card',
  'discounts.apply', 'discounts.manage',
  'expenses.view', 'expenses.manage',
  'kitchen.view', 'kitchen.manage',
  'staff.manage',
  'settings.manage',
];

// ── Build nav ─────────────────────────────────────────────────────────────────

function buildGroups(permissions: Record<string, boolean>): ModuleGroup[] {
  const isWildcard = permissions['*'] === true;

  // Resolve effective granted keys
  let grantedKeys: string[];

  if (isWildcard) {
    // Owner / wildcard — expand to all known keys
    grantedKeys = ALL_KNOWN_KEYS;
  } else {
    // Explicit grants only — strictly filter to granted === true
    grantedKeys = Object.entries(permissions)
      .filter(([key, granted]) => granted === true && key !== '*')
      .map(([key]) => key);
  }

  if (grantedKeys.length === 0) return [];

  // Group by module prefix
  const map: Record<string, string[]> = {};
  grantedKeys.forEach(key => {
    const prefix = deriveModule(key);
    if (!map[prefix]) map[prefix] = [];
    // Avoid duplicates (safety guard)
    if (!map[prefix].includes(key)) map[prefix].push(key);
  });

  // Sort modules: known order first, then alpha for unknowns
  const knownOrder = Object.keys(MODULE_META);
  return Object.entries(map)
    .sort(([a], [b]) => {
      const ai = knownOrder.indexOf(a);
      const bi = knownOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    })
    .map(([prefix, keys]) => ({ prefix, keys, ...getModuleMeta(prefix) }));
}

// ── Generic fallback ──────────────────────────────────────────────────────────

function GenericPermissionView({ permissionKey }: RichProps) {
  const { icon } = getModuleMeta(deriveModule(permissionKey));
  return (
    <div style={gv.root}>
      <div style={gv.iconWrap}><span style={gv.icon}>{icon}</span></div>
      <code style={gv.key}>{permissionKey}</code>
      <p style={gv.title}>{getKeyLabel(permissionKey)}</p>
      <p style={gv.body}>
        You have the <strong style={{ color: '#93c5fd' }}>{getKeyLabel(permissionKey)}</strong> permission.
        A dedicated screen for this section hasn't been built yet and will be available in a future update.
      </p>
      <div style={gv.hint}>
        <span>💡</span>
        <span>
          This permission allows <code style={gv.inlineCode}>{permissionKey}</code> actions in SwiftPOS.
          Contact your administrator for more information.
        </span>
      </div>
    </div>
  );
}

const gv: Record<string, React.CSSProperties> = {
  root:       { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 20px', textAlign: 'center' },
  iconWrap:   { width: 72, height: 72, background: '#0f172a', borderRadius: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14, border: '1px solid #334155' },
  icon:       { fontSize: 34 },
  key:        { margin: '0 0 10px', fontSize: 11, color: '#475569', background: '#0f172a', padding: '3px 10px', borderRadius: 6, border: '1px solid #334155' },
  title:      { margin: '0 0 10px', fontSize: 18, fontWeight: 700, color: '#f1f5f9' },
  body:       { margin: '0 0 20px', fontSize: 13, color: '#64748b', lineHeight: 1.7, maxWidth: 300 },
  hint:       { display: 'flex', gap: 10, alignItems: 'flex-start', background: '#0f172a', border: '1px solid #334155', borderRadius: 10, padding: '12px 14px', maxWidth: 300, textAlign: 'left', fontSize: 12, color: '#64748b', lineHeight: 1.6 },
  inlineCode: { background: '#1e293b', padding: '1px 5px', borderRadius: 4, fontSize: 11 },
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function POSDrawer({ isOpen, onClose, currency }: Props) {
  const { session } = usePOSAuth();

  const groups = buildGroups(session?.permissions ?? {});

  const [activeModule, setActiveModule] = useState<string | null>(groups[0]?.prefix ?? null);
  const [activeKey,    setActiveKey]    = useState<string | null>(groups[0]?.keys[0] ?? null);

  // Re-sync on session change (role switches, re-login)
  useEffect(() => {
    const g = buildGroups(session?.permissions ?? {});
    setActiveModule(g[0]?.prefix ?? null);
    setActiveKey(g[0]?.keys[0] ?? null);
  }, [session]);

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

  const activeGroup = groups.find(g => g.prefix === activeModule) ?? null;

  const switchModule = (prefix: string) => {
    const grp = groups.find(g => g.prefix === prefix);
    setActiveModule(prefix);
    setActiveKey(grp?.keys[0] ?? null);
  };

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
        {groups.length === 0 && (
          <div style={s.empty}>
            <p style={{ fontSize: 36, margin: '0 0 12px' }}>🔒</p>
            <p style={s.emptyText}>No additional sections have been granted to your role.</p>
          </div>
        )}

        {/* Two-column layout */}
        {groups.length > 0 && (
          <div style={s.body}>

            {/* Left rail — module tabs */}
            <nav style={s.rail}>
              {groups.map(grp => (
                <button
                  key={grp.prefix}
                  style={{ ...s.railTab, ...(activeModule === grp.prefix ? s.railTabActive : {}) }}
                  onClick={() => switchModule(grp.prefix)}
                  title={grp.label}
                >
                  <span style={s.railIcon}>{grp.icon}</span>
                  <span style={s.railLabel}>{grp.label}</span>
                </button>
              ))}
            </nav>

            {/* Right area */}
            <div style={s.main}>

              {/* Sub-tabs — only rendered when module has >1 key */}
              {activeGroup && activeGroup.keys.length > 1 && (
                <div style={s.subTabs}>
                  {activeGroup.keys.map(key => (
                    <button
                      key={key}
                      style={{ ...s.subTab, ...(activeKey === key ? s.subTabActive : {}) }}
                      onClick={() => setActiveKey(key)}
                    >
                      {getKeyLabel(key)}
                    </button>
                  ))}
                </div>
              )}

              {/* Content */}
              <div style={s.content}>
                {activeKey && (() => {
                  const Rich = RICH_COMPONENTS[activeKey];
                  if (Rich) return <Rich currency={currency} permissionKey={activeKey} />;
                  return <GenericPermissionView currency={currency} permissionKey={activeKey} />;
                })()}
              </div>
            </div>

          </div>
        )}
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
  railTabActive: {
    color: '#93c5fd', borderLeftColor: '#3b82f6', background: 'rgba(59,130,246,0.08)',
  },
  railIcon:  { fontSize: 20 },
  railLabel: { lineHeight: 1.2, width: 68, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },

  // Right main
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },

  // Sub-tabs
  subTabs: {
    display: 'flex', borderBottom: '1px solid #334155',
    overflowX: 'auto' as const, flexShrink: 0,
  },
  subTab: {
    padding: '9px 14px', background: 'transparent', border: 'none',
    borderBottom: '2px solid transparent', color: '#64748b',
    cursor: 'pointer', fontSize: 12, fontWeight: 600,
    whiteSpace: 'nowrap' as const, transition: 'all 0.15s ease',
  },
  subTabActive: {
    color: '#3b82f6', borderBottomColor: '#3b82f6', background: 'rgba(59,130,246,0.06)',
  },

  // Content
  content: { flex: 1, overflowY: 'auto' as const, padding: '14px 16px 24px' },
};
