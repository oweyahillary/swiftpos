import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth }     from '../context/AuthContext';
import { useBusiness } from '../context/BusinessContext';
import { useTheme }    from '../context/ThemeContext';
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';
import BranchSelector from './BranchSelector';

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button onClick={toggleTheme}
      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors">
      <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
      <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}

interface Notification {
  id: string; type: string; title: string;
  message: string | null; link: string | null;
  read_at: string | null; created_at: string;
}

interface NavItem  { to: string; label: string; icon: string; end?: boolean; badgeKey?: string; verticals?: string[]; }
interface NavGroup { label: string; icon: string; items: NavItem[]; verticals?: string[]; }
type NavEntry = NavItem | NavGroup;

function isGroup(e: NavEntry): e is NavGroup { return 'items' in e; }

// Verticals that use restaurant/café features (table service, kitchen, recipes).
// Items/groups tagged with `verticals` only show for those business types; an
// untagged entry shows for every vertical.
const FOOD_VERTICALS = ['restaurant', 'cafe'];

const TYPE_SETTINGS: Record<string, NavItem> = {
  restaurant:     { to: '/dashboard/settings/restaurant', label: 'Restaurant Setup', icon: '🍽️' },
  cafe:           { to: '/dashboard/settings/restaurant', label: 'Café Setup',       icon: '☕' },
  minimart:       { to: '/dashboard/settings/minimart',   label: 'Minimart Setup',   icon: '🏪' },
  parking:        { to: '/dashboard/settings/parking',    label: 'Parking Setup',    icon: '🅿️' },
  petrol_station: { to: '/dashboard/settings/petrol',     label: 'Petrol Setup',     icon: '⛽' },
};

const NAV: NavEntry[] = [
  { to: '/dashboard',          label: 'Overview',  icon: '▦', end: true },
  { to: '/dashboard/pos',      label: 'POS',       icon: '⊡' },
  { to: '/dashboard/inventory',    label: 'Inventory',   icon: '📦', badgeKey: 'inventory' },
  { to: '/dashboard/reservations', label: 'Reservations', icon: '📅', verticals: FOOD_VERTICALS },
  {
    label: 'Menu', icon: '◈',
    items: [
      { to: '/dashboard/categories', label: 'Categories', icon: '◈' },
      { to: '/dashboard/products',   label: 'Products',   icon: '⊞' },
      { to: '/dashboard/discounts',  label: 'Discounts',  icon: '🏷️' },
      { to: '/dashboard/promotions', label: 'Promotions',   icon: '🎉' },
      { to: '/dashboard/combos',     label: 'Combo Meals',  icon: '🍱', verticals: FOOD_VERTICALS },
    ],
  },
  {
    label: 'Stock', icon: '⬡',
    items: [
      { to: '/dashboard/stock/ingredients',     label: 'Ingredients',     icon: '🧂', verticals: FOOD_VERTICALS },
      { to: '/dashboard/stock/purchase-orders', label: 'Purchase Orders', icon: '📋' },
      { to: '/dashboard/stock/suppliers',       label: 'Suppliers',       icon: '🏭' },
      { to: '/dashboard/stock/transfers',       label: 'Transfers',       icon: '🔄' },
    ],
  },
  {
    label: 'Finance', icon: '💸',
    items: [
      { to: '/dashboard/expenses', label: 'Expenses', icon: '💸' },
      { to: '/dashboard/reports',  label: 'Reports',  icon: '📊' },
    ],
  },
  {
    label: 'Customers', icon: '👥',
    items: [
      { to: '/dashboard/customers', label: 'Customers', icon: '👥' },
      { to: '/dashboard/customers/credit', label: 'Credit Accounts', icon: '🧾' },
    ],
  },
  {
    label: 'Settings', icon: '⚙',
    items: [
      { to: '/dashboard/branches', label: 'Branches',         icon: '🏪' },
      { to: '/dashboard/printers', label: 'Printers',         icon: '🖨️' },
      { to: '/dashboard/turnover', label: 'Table Turnover',   icon: '⏱️', verticals: FOOD_VERTICALS },
      { to: '/dashboard/settings/etims', label: 'KRA eTIMS',        icon: '🧾' },
      { to: '/dashboard/settings', label: 'Staff Management', icon: '👥', end: true },
      { to: '/kds',                label: 'KDS',              icon: '🍽️', verticals: FOOD_VERTICALS },
    ],
  },
];

const DEFAULT_OPEN = new Set(['Menu', 'Catalogue', 'Stock', 'Finance', 'Setup']);

const TYPE_ICON: Record<string, string> = {
  low_stock: '⚠️', daily_summary: '📊', default: '🔔',
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMins < 1)  return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24)  return `${diffHrs}h ago`;
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

function NavGroupItem({ group, defaultOpen }: { group: NavGroup; defaultOpen: boolean }) {
  const location = useLocation();
  const hasActive = group.items.some(i =>
    location.pathname === i.to || location.pathname.startsWith(i.to + '/')
  );
  const [open, setOpen] = useState(defaultOpen || hasActive);

  useEffect(() => { if (hasActive) setOpen(true); }, [hasActive]);

  return (
    <div>
      <button onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors group ${
          hasActive ? 'text-green-400' : 'text-gray-400 hover:text-white hover:bg-gray-800'
        }`}>
        <div className="flex items-center gap-3">
          <span className="text-base">{group.icon}</span>
          <span className="font-medium">{group.label}</span>
        </div>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          className={`transition-transform duration-200 flex-shrink-0 ${open ? 'rotate-180' : ''} ${
            hasActive ? 'text-green-400' : 'text-gray-600 group-hover:text-gray-400'
          }`}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="mt-0.5 ml-3 pl-3 border-l border-gray-800 space-y-0.5">
          {group.items.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end ?? item.to === '/dashboard'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-green-500/10 text-green-400' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`
              }>
              <span className="text-sm">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DashboardLayout() {
  const { signOut } = useAuth();
  const { business } = useBusiness();

  // Build Setup group dynamically — inject business-type link
  const setupGroup: NavGroup = {
    label: 'Setup',
    icon: '⚙',
    items: [
      { to: '/dashboard/branches', label: 'Branches',         icon: '🏪' },
      { to: '/dashboard/printers', label: 'Printers',         icon: '🖨️' },
      { to: '/dashboard/turnover', label: 'Table Turnover',   icon: '⏱️', verticals: FOOD_VERTICALS },
      { to: '/dashboard/settings/etims', label: 'KRA eTIMS',        icon: '🧾' },
      { to: '/dashboard/settings', label: 'Staff Management', icon: '👥', end: true },
      ...(business?.type && TYPE_SETTINGS[business.type] ? [TYPE_SETTINGS[business.type]] : []),
      { to: '/kds',                label: 'KDS',              icon: '🍽️', verticals: FOOD_VERTICALS },
    ],
  };

  // Replace the static 'Settings' group with the dynamic 'Setup' group, then
  // tailor the menu to the business vertical: drop restaurant-only entries
  // (Reservations, Combo Meals, Ingredients, Table Turnover, KDS) for petrol /
  // retail / parking / minimart, and relabel the "Menu" group as "Catalogue"
  // where "Menu" reads as restaurant jargon. Empty groups are dropped.
  const vertical = business?.type ?? '';
  const known = vertical !== '';
  const allowed = (v?: string[]) => !v || !known || v.includes(vertical);
  const isFood = !known || FOOD_VERTICALS.includes(vertical);

  const nav: NavEntry[] = NAV
    .map(e => (isGroup(e) && e.label === 'Settings' ? setupGroup : e))
    .map(e => {
      if (!isGroup(e)) return e;
      const label = e.label === 'Menu' && !isFood ? 'Catalogue' : e.label;
      return { ...e, label, items: e.items.filter(it => allowed(it.verticals)) };
    })
    .filter(e => (isGroup(e) ? allowed(e.verticals) && e.items.length > 0 : allowed(e.verticals)));

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount]     = useState(0);
  const [bellOpen, setBellOpen]           = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const { notifications: data, unreadCount: count } = await api.get<{
        notifications: Notification[]; unreadCount: number;
      }>('/api/notifications?limit=10');
      setNotifications(data);
      setUnreadCount(count);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 60_000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ── Low-stock badge ─────────────────────────────────────────────────────────
  const [lowStockCount, setLowStockCount] = useState(0);

  useEffect(() => {
    async function checkLowStock() {
      try {
        const items = await api.get<{ id: string; current_stock: number; reorder_level: number }[]>(
          '/api/stock/ingredients?status=active'
        );
        const count = (items ?? []).filter(i => Number(i.current_stock) <= Number(i.reorder_level)).length;
        setLowStockCount(count);
      } catch { /* non-critical */ }
    }
    checkLowStock();
    const interval = setInterval(checkLowStock, 5 * 60_000); // every 5 min
    return () => clearInterval(interval);
  }, []);

  const markRead = async (id: string) => {
    try {
      await api.patch(`/api/notifications/${id}/read`, {});
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch { /* silent */ }
  };

  const markAllRead = async () => {
    try {
      await api.patch('/api/notifications/read-all', {});
      setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
      setUnreadCount(0);
    } catch { /* silent */ }
  };

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">

        {/* Logo + bell */}
        <div className="px-5 py-5 border-b border-gray-800 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-white font-bold text-lg truncate">{business?.name ?? '…'}</p>
            <BranchSelector />
          </div>
          <div className="relative flex-shrink-0" ref={bellRef}>
            <button onClick={() => setBellOpen(p => !p)}
              className="relative p-1.5 text-gray-500 hover:text-white transition-colors rounded-lg hover:bg-gray-800">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[9px] font-bold min-w-[16px] h-4 rounded-full flex items-center justify-center px-0.5">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            {bellOpen && (
              <div className="absolute left-0 top-full mt-2 w-80 bg-gray-900 border border-gray-800 rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                  <p className="text-white text-sm font-semibold">Notifications</p>
                  {unreadCount > 0 && (
                    <button onClick={markAllRead} className="text-xs text-green-500 hover:text-green-400 transition-colors">
                      Mark all read
                    </button>
                  )}
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="px-4 py-8 text-center">
                      <p className="text-2xl mb-2">🔔</p>
                      <p className="text-gray-500 text-sm">No notifications yet</p>
                    </div>
                  ) : notifications.map(n => (
                    <div key={n.id} onClick={() => { if (!n.read_at) markRead(n.id); }}
                      className={`flex gap-3 px-4 py-3 border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/40 ${!n.read_at ? 'bg-green-500/5' : ''}`}>
                      <span className="text-base flex-shrink-0 mt-0.5">{TYPE_ICON[n.type] ?? TYPE_ICON.default}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`text-xs font-medium leading-tight ${n.read_at ? 'text-gray-400' : 'text-white'}`}>{n.title}</p>
                          {!n.read_at && <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-green-500 mt-1" />}
                        </div>
                        {n.message && <p className="text-gray-500 text-xs mt-0.5 line-clamp-2">{n.message}</p>}
                        <p className="text-gray-600 text-xs mt-1">{fmtTime(n.created_at)}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-2.5 border-t border-gray-800">
                  <button onClick={() => { setBellOpen(false); fetchNotifications(); }}
                    className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                    Refresh
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {nav.map((entry) =>
            isGroup(entry) ? (
              <NavGroupItem key={entry.label} group={entry} defaultOpen={DEFAULT_OPEN.has(entry.label)} />
            ) : (
              <NavLink key={entry.to} to={entry.to} end={entry.end ?? entry.to === '/dashboard'}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive ? 'bg-green-500/10 text-green-400' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`
                }>
                <span className="text-base">{entry.icon}</span>
                {entry.label}
              </NavLink>
            )
          )}
        </nav>

        <div className="px-3 py-4 border-t border-gray-800 space-y-1">
          <ThemeToggle />
          <button onClick={signOut}
            className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors">
            Sign out
          </button>
          <p className="px-3 pt-1 text-[10px] text-gray-600 select-none">Powered by SwiftPOS</p>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        <Outlet />
      </main>
    </div>
  );
}
