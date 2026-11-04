import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

// Shared shell for the three Settings sections (Users and access, Devices and
// printers, Business). Renders the section title + a horizontal sub-tab bar of
// NavLinks; the active child route renders into the Outlet. URL-addressable so
// deep links and the browser back button work (register A133).
//
// A620 (owner, 2026-11-01, Settings › Business: "the top nav is cluttered"): a section may pass `groups` instead — a
// grouped menu on the left, like the main navigation (a dropdown on a phone). `tabs` stays the flat list either way.

export interface SettingsTab {
  to: string;         // relative child path, e.g. 'staff'
  label: string;
  end?: boolean;
}

/** A620: a titled group of the left menu (Your business, Selling, Setup, Integrations). */
export interface SettingsGroup {
  title: string;
  tabs: SettingsTab[];
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-lg text-sm transition-colors ${
    isActive
      ? 'bg-gray-800 text-white font-medium'
      : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
  }`;

export default function SettingsSection(
  { title, tabs, groups, context }: { title: string; tabs: SettingsTab[]; groups?: SettingsGroup[]; context?: unknown }
) {
  if (groups?.length) return <GroupedSection title={title} groups={groups} context={context} />;
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-3 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-white text-xl sm:text-2xl font-bold">{title}</h1>
        <nav className="flex gap-1 mt-3 flex-wrap">
          {tabs.map(t => (
            <NavLink key={t.to} to={t.to} end={t.end} className={linkClass}>
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Outlet context={context} />
      </div>
    </div>
  );
}

/**
 * A620: the grouped menu — on the left from md up, a dropdown above the page on a phone. ONE scroller: the dashboard's
 * main area scrolls the page as everywhere else, and the menu stays pinned beside it (owner, 2026-11-02: an inner
 * scroller under Branding "leads to endless scrolling"; "make the navbar a bit visible").
 */
function GroupedSection({ title, groups, context }: { title: string; groups: SettingsGroup[]; context?: unknown }) {
  return (
    <div className="flex flex-col">
      <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-3 border-b border-gray-800">
        <h1 className="text-white text-xl sm:text-2xl font-bold">{title}</h1>
        <PhoneMenu groups={groups} />
      </div>
      <div className="flex items-start">
        <nav aria-label={`${title} settings`} data-testid="settings-groups"
          className="hidden md:block w-60 flex-shrink-0 sticky top-0 self-start max-h-screen overflow-y-auto border-r border-gray-800 bg-gray-900/60 py-5 px-3">
          {groups.map(g => (
            <div key={g.title} className="mb-5 last:mb-0">
              <p className="px-3 mb-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-400">{g.title}</p>
              <div className="flex flex-col gap-0.5">
                {g.tabs.map(t => (
                  <NavLink key={t.to} to={t.to} end={t.end} className={groupLinkClass}>{t.label}</NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="flex-1 min-w-0">
          <Outlet context={context} />
        </div>
      </div>
    </div>
  );
}

/** A620: a link in the grouped menu — brighter than the top tabs, the current page marked with a teal bar. */
const groupLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-2 rounded-lg text-sm border-l-2 transition-colors ${
    isActive
      ? 'border-swift bg-gray-800 text-white font-medium'
      : 'border-transparent text-gray-300 hover:text-white hover:bg-gray-800/60'
  }`;

/** A620: on a phone, the same menu as one dropdown (grouped options). */
function PhoneMenu({ groups }: { groups: SettingsGroup[] }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const all = groups.flatMap(g => g.tabs);
  const current = all.find(t => pathname.endsWith(`/${t.to}`) || pathname.includes(`/${t.to}/`))?.to ?? '';
  return (
    <select aria-label="Settings page" value={current} onChange={e => navigate(e.target.value)}
      className="md:hidden mt-3 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift">
      {!current && <option value="">Choose a page…</option>}
      {groups.map(g => (
        <optgroup key={g.title} label={g.title}>
          {g.tabs.map(t => <option key={t.to} value={t.to}>{t.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
