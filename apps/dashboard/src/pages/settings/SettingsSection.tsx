import { NavLink, Outlet } from 'react-router-dom';

// Shared shell for the three Settings sections (Users and access, Devices and
// printers, Business). Renders the section title + a horizontal sub-tab bar of
// NavLinks; the active child route renders into the Outlet. URL-addressable so
// deep links and the browser back button work (register A133).

export interface SettingsTab {
  to: string;         // relative child path, e.g. 'staff'
  label: string;
  end?: boolean;
}

export default function SettingsSection(
  { title, tabs, context }: { title: string; tabs: SettingsTab[]; context?: unknown }
) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-3 border-b border-gray-800 flex-shrink-0">
        <h1 className="text-white text-2xl font-bold">{title}</h1>
        <nav className="flex gap-1 mt-3 flex-wrap">
          {tabs.map(t => (
            <NavLink key={t.to} to={t.to} end={t.end}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-gray-800 text-white font-medium'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                }`
              }>
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
