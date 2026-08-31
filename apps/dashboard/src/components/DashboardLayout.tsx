import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth }     from '../context/AuthContext';
import { useBusiness } from '../context/BusinessContext';
import { useTheme }    from '../context/ThemeContext';
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';
import BranchSelector from './BranchSelector';
import { useBranch } from '../context/BranchContext';

// ── Icon set — monochrome outline, ported from the desktop app's style ────────
// One curated stroke path per nav concept, in place of the mixed emoji the web
// nav used. Same 24×24 stroke geometry as the till's icons so the two apps read
// as one product. Colour comes from the surrounding text class via currentColor.
const ICONS: Record<string, string> = {
  overview:  'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
  till:      'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2',
  inventory: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  reservations: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  menu:      'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  categories:'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  products:  'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
  discounts: 'M7 7h.01M3 4a1 1 0 011-1h6.586a1 1 0 01.707.293l8 8a2 2 0 010 2.828l-6.586 6.586a2 2 0 01-2.828 0l-8-8A1 1 0 013 10V4z',
  payments:  'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
  promotions:'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
  combos:    'M12 8v13m0-13V6a2 2 0 112-2 2 2 0 012 2 2 2 0 01-2 2h-2m0 0V5.5A2.5 2.5 0 008 5.5V6a2 2 0 002 2m10 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V10a2 2 0 012-2h12a2 2 0 012 2z',
  stock:     'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
  ingredients:'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
  purchase_orders:'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  suppliers: 'M9 17a2 2 0 11-4 0 2 2 0 014 0zM20 17a2 2 0 11-4 0 2 2 0 014 0zM13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1h6',
  transfers: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
  finance:   'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z',
  expenses:  'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h10a2 2 0 012 2v14a2 2 0 01-2 2z',
  reports:   'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  drawers:   'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4',
  customers: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  credit:    'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  settings:  'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4',
  branches:  'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
  printers:  'M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z',
  stations:  'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z',
  tills:     'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
  turnover:  'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  etims:     'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  staff:     'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m0 0a4 4 0 105.292 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  kds:       'M9 17v2m6-2v2M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2zM8 21h8',
  packaged:  'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  restaurant:'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z',
  cafe:      'M3 8h13a2 2 0 012 2v1a4 4 0 01-4 4H7a4 4 0 01-4-4V8zM16 8h2a2 2 0 012 2 2 2 0 01-2 2h-1M6 2v2M10 2v2M14 2v2',
  minimart:  'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
  parking:   'M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0zM15 11a3 3 0 11-6 0 3 3 0 016 0z',
  petrol:    'M13 10V3L4 14h7v7l9-11h-7z',
  // chrome — theme toggle + notification types, same outline set as the nav
  sun:       'M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z',
  moon:      'M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z',
  warning:   'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  summary:   'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  bell:      'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
  dot:       'M12 12h.01',
};

function NavIcon({ name, className, size = 18 }: { name: string; className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.dot} />
    </svg>
  );
}

// The final rendered group label the current route belongs to (labels are
// vertical-relabelled, so this must run against the computed `nav`, not NAV).
function activeGroupLabel(nav: NavEntry[], pathname: string): string | null {
  for (const e of nav) {
    if (!isGroup(e)) continue;
    if (e.items.some(i => pathname === i.to || pathname.startsWith(i.to + '/'))) return e.label;
  }
  return null;
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button onClick={toggleTheme}
      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors">
      <NavIcon name={theme === 'dark' ? 'sun' : 'moon'} className="flex-shrink-0" />
      <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}

interface Notification {
  id: string; type: string; title: string;
  message: string | null; link: string | null;
  read_at: string | null; created_at: string;
}

interface NavItem  { to: string; label: string; icon: string; end?: boolean; badgeKey?: string; verticals?: string[]; hint?: string; sub?: string; }
interface NavGroup { label: string; icon: string; items: NavItem[]; verticals?: string[]; }
type NavEntry = NavItem | NavGroup;

function isGroup(e: NavEntry): e is NavGroup { return 'items' in e; }

// Verticals that use restaurant/café features (table service, kitchen, recipes).
// Items/groups tagged with `verticals` only show for those business types; an
// untagged entry shows for every vertical.
const FOOD_VERTICALS = ['restaurant', 'cafe'];

const NAV: NavEntry[] = [
  { to: '/dashboard',          label: 'Overview',  icon: 'overview', end: true },
  { to: '/dashboard/pos',      label: 'POS',      icon: 'till' },
  // KDS moved out of Settings — it is a live operational screen, not a setting.
  { to: '/kds',                label: 'KDS',      icon: 'kds', verticals: FOOD_VERTICALS },
  { to: '/dashboard/inventory',    label: 'Inventory',   icon: 'inventory', badgeKey: 'inventory' },
  { to: '/dashboard/reservations', label: 'Reservations', icon: 'reservations', verticals: FOOD_VERTICALS },
  {
    label: 'Menu', icon: 'menu',
    items: [
      { to: '/dashboard/categories', label: 'Categories', icon: 'categories' },
      { to: '/dashboard/products',   label: 'Products',   icon: 'products' },
      { to: '/dashboard/discounts',  label: 'Discounts',  icon: 'discounts' },
      // Payment methods moved to Settings › Business › Payments (it is tender
      // configuration, not catalogue).
      { to: '/dashboard/promotions', label: 'Promotions',   icon: 'promotions' },
      { to: '/dashboard/combos',     label: 'Combo Meals',  icon: 'combos', verticals: FOOD_VERTICALS },
    ],
  },
  {
    label: 'Stock', icon: 'stock',
    items: [
      { to: '/dashboard/stock/ingredients',     label: 'Ingredients',     icon: 'ingredients', verticals: FOOD_VERTICALS },
      { to: '/dashboard/stock/purchase-orders', label: 'Purchase Orders', icon: 'purchase_orders' },
      { to: '/dashboard/stock/suppliers',       label: 'Suppliers',       icon: 'suppliers' },
      { to: '/dashboard/stock/transfers',       label: 'Transfers',       icon: 'transfers' },
    ],
  },
  {
    label: 'Finance', icon: 'finance',
    items: [
      { to: '/dashboard/orders',   label: 'Orders',   icon: 'reports' },
      { to: '/dashboard/expenses', label: 'Expenses', icon: 'expenses' },
      { to: '/dashboard/reports',  label: 'Reports',  icon: 'reports' },
      // Table Turnover moved out of Settings — it is a report, not configuration.
      { to: '/dashboard/turnover', label: 'Table Turnover', icon: 'turnover', verticals: FOOD_VERTICALS },
      // Under Finance rather than Settings: it is a cash-custody action, and it is
      // the only route to a drawer stranded on a terminal that has died.
      { to: '/dashboard/open-drawers', label: 'Open Drawers', icon: 'drawers' },
    ],
  },
  {
    label: 'Customers', icon: 'customers',
    items: [
      { to: '/dashboard/customers', label: 'Customers', icon: 'customers' },
      { to: '/dashboard/customers/credit', label: 'Credit Accounts', icon: 'credit' },
    ],
  },
  {
    label: 'Settings', icon: 'settings',
    items: [
      { to: '/dashboard/settings/users',    label: 'Users and access',     icon: 'staff' },
      { to: '/dashboard/settings/devices',  label: 'Devices and printers', icon: 'printers' },
      { to: '/dashboard/settings/business', label: 'Business',             icon: 'branches' },
    ],
  },
];

const TYPE_ICON: Record<string, string> = {
  low_stock: 'warning', daily_summary: 'summary', default: 'bell',
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

function NavGroupItem({ group, isOpen, onToggle }: { group: NavGroup; isOpen: boolean; onToggle: () => void }) {
  const location = useLocation();
  const hasActive = group.items.some(i =>
    location.pathname === i.to || location.pathname.startsWith(i.to + '/')
  );

  return (
    <div>
      <button onClick={onToggle} aria-expanded={isOpen}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors group ${
          hasActive ? 'text-green-400' : 'text-gray-400 hover:text-white hover:bg-gray-800'
        }`}>
        <div className="flex items-center gap-3">
          <NavIcon name={group.icon} className="flex-shrink-0" />
          <span className="font-bold uppercase tracking-wider text-xs">{group.label}</span>
        </div>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          className={`transition-transform duration-200 flex-shrink-0 ${isOpen ? 'rotate-180' : ''} ${
            hasActive ? 'text-green-400' : 'text-gray-600 group-hover:text-gray-400'
          }`}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {isOpen && (
        <div className="mt-0.5 ml-3 pl-3 border-l border-gray-800 space-y-0.5">
          {group.items.map(item => (
            <NavLink key={item.to} to={item.to} title={item.hint}
              end={item.end ?? (item.to === '/dashboard'
                || group.items.some(s => s.to !== item.to && s.to.startsWith(item.to + '/')))}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-green-500/10 text-green-400' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`
              }>
              <NavIcon name={item.icon} className="flex-shrink-0" />
              {item.sub ? (
                <span className="flex flex-col leading-tight min-w-0">
                  <span className="truncate">{item.label}</span>
                  <span className="text-[10px] text-gray-600 truncate">{item.sub}</span>
                </span>
              ) : item.label}
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
  const { activeBranchId } = useBranch();

  // Tailor the menu to the business vertical: drop restaurant-only entries
  // (Reservations, Combo Meals, Ingredients, Table Turnover, KDS) for petrol /
  // retail / parking / minimart, and relabel the "Menu" group as "Catalogue"
  // where "Menu" reads as restaurant jargon. Empty groups are dropped. The
  // Settings group is now static (three sections resolve their own vertical
  // specifics internally), so no dynamic rebuild is needed here (A133).
  const vertical = business?.type ?? '';
  const known = vertical !== '';
  const allowed = (v?: string[]) => !v || !known || v.includes(vertical);
  const isFood = !known || FOOD_VERTICALS.includes(vertical);

  // Restaurant-friendly item relabels (food verticals only). Retail keeps the
  // generic terms (Products, Categories) that a minimart owner expects.
  const foodItemLabel: Record<string, string> = {
    '/dashboard/products':   'Menu Items',
    '/dashboard/categories': 'Menu Sections',
    '/dashboard/promotions': 'Specials',
    '/dashboard/combos':     'Set Meals',
    '/dashboard/inventory':  'Bar & Packaged Stock',
  };
  // Tooltips to disambiguate the easily-confused items (users can hover; a full
  // manual can expand on these later).
  const hintFor = (to: string): string | undefined => {
    switch (to) {
      case '/dashboard/products':          return 'The items you sell';
      case '/dashboard/categories':        return isFood ? 'Groups menu items into sections' : 'Groups products into categories';
      case '/dashboard/stock/ingredients': return 'Raw materials that deplete automatically when a dish is sold';
      case '/dashboard/inventory':         return isFood
        ? 'Countable packaged goods sold as-is (bottled drinks, snacks)'
        : 'Stock on hand for each product';
      default: return undefined;
    }
  };
  // Short, always-visible sub-labels for the three genuinely-confusable items
  // (works on touch, unlike the hover tooltip). Kept to a couple of words.
  const subFor = (to: string): string | undefined => {
    switch (to) {
      case '/dashboard/products':          return isFood ? 'What you sell' : undefined;
      case '/dashboard/stock/ingredients': return 'Raw materials';
      case '/dashboard/inventory':         return isFood ? 'Packaged goods' : undefined;
      default: return undefined;
    }
  };
  const relabel = (it: NavItem): NavItem => {
    const label = isFood && foodItemLabel[it.to] ? foodItemLabel[it.to] : it.label;
    const out: NavItem = { ...it, label };
    const hint = hintFor(it.to); if (hint) out.hint = hint;
    const sub  = subFor(it.to);  if (sub)  out.sub  = sub;
    return out;
  };
  // For food verticals the product-stock page moves out of the top level and into
  // the Inventory group as packaged goods (bottled drinks etc.), so a restaurant
  // has ONE inventory section: ingredients + packaged goods.
  const packagedStockItem: NavItem = {
    to: '/dashboard/inventory', label: 'Bar & Packaged Stock', icon: 'packaged', badgeKey: 'inventory',
  };

  const nav: NavEntry[] = NAV
    // Food: drop the top-level Inventory tab (folded into the Inventory group below).
    .filter(e => !(isFood && !isGroup(e) && e.to === '/dashboard/inventory'))
    .map(e => {
      if (!isGroup(e)) {
        const item = allowed(e.verticals) ? relabel(e) : e;
        // KDS is a standalone full-screen page keyed by branch; without a
        // branch_id it shows "Missing branch ID". Carry the active branch so the
        // link opens straight to this branch's board (A133 follow-up).
        if (item.to === '/kds' && activeBranchId) {
          return { ...item, to: `/kds?branch_id=${activeBranchId}` };
        }
        return item;
      }
      let label = e.label;
      if (e.label === 'Menu')  label = isFood ? 'Menu' : 'Catalogue';
      if (e.label === 'Stock') label = isFood ? 'Inventory' : 'Purchasing';
      let items = e.items.filter(it => allowed(it.verticals)).map(relabel);
      if (isFood && e.label === 'Stock') {
        const idx = items.findIndex(i => i.to === '/dashboard/stock/ingredients');
        const at  = idx >= 0 ? idx + 1 : 0;
        items = [...items.slice(0, at), relabel(packagedStockItem), ...items.slice(at)];
      }
      return { ...e, label, items };
    })
    .filter(e => (isGroup(e) ? allowed(e.verticals) && e.items.length > 0 : allowed(e.verticals)));

  // ── Accordion nav: exactly one group open at a time ─────────────────────────
  // On load, only the group holding the current route is open (nothing else),
  // which fixes the old "everything expanded" wall. Opening a group closes the
  // others. The choice is remembered across reloads, and navigating into a page
  // always opens its group.
  const navLocation = useLocation();
  const activeGroup = activeGroupLabel(nav, navLocation.pathname);
  const [openGroup, setOpenGroup] = useState<string | null>(() => {
    if (activeGroup) return activeGroup;
    try { return localStorage.getItem('nav.openGroup'); } catch { return null; }
  });
  useEffect(() => { if (activeGroup) setOpenGroup(activeGroup); }, [activeGroup]);
  useEffect(() => {
    try {
      if (openGroup) localStorage.setItem('nav.openGroup', openGroup);
      else localStorage.removeItem('nav.openGroup');
    } catch { /* storage unavailable — in-memory only */ }
  }, [openGroup]);
  const toggleGroup = (label: string) => setOpenGroup(cur => (cur === label ? null : label));

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
                      <div className="flex justify-center mb-2 text-gray-600"><NavIcon name="bell" size={28} /></div>
                      <p className="text-gray-500 text-sm">No notifications yet</p>
                    </div>
                  ) : notifications.map(n => (
                    <div key={n.id} onClick={() => { if (!n.read_at) markRead(n.id); }}
                      className={`flex gap-3 px-4 py-3 border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/40 ${!n.read_at ? 'bg-green-500/5' : ''}`}>
                      <NavIcon name={TYPE_ICON[n.type] ?? TYPE_ICON.default} className="flex-shrink-0 mt-0.5 text-gray-400" />
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
              <NavGroupItem key={entry.label} group={entry}
                isOpen={openGroup === entry.label}
                onToggle={() => toggleGroup(entry.label)} />
            ) : (
              <NavLink key={entry.to} to={entry.to} title={entry.hint} end={entry.end ?? entry.to === '/dashboard'}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive ? 'bg-green-500/10 text-green-400' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`
                }>
                <NavIcon name={entry.icon} className="flex-shrink-0" />
                {entry.sub ? (
                  <span className="flex flex-col leading-tight min-w-0">
                    <span className="truncate">{entry.label}</span>
                    <span className="text-[10px] text-gray-600 truncate">{entry.sub}</span>
                  </span>
                ) : entry.label}
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

      <main className="flex-1 overflow-y-auto flex flex-col">
        <Outlet key={activeBranchId ?? 'all'} />
      </main>
    </div>
  );
}
