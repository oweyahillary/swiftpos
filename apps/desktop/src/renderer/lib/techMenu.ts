/**
 * techMenu.ts — A622: the Tech page's menu (owner, 2026-11-04: "the tech screen is too long for scrolling can we add a
 * menu to it for each section").
 *
 * One section shows at a time, picked from a menu at the top that stays in view; the last one picked is kept for the
 * next Tech session on this POS (a per-POS convenience — nothing breaks without it). Related pieces share a section:
 * the customer screen sits with the device, rejoining with the branch role, the history upload with the backups.
 */
export type TechSection = 'device' | 'sync' | 'logs' | 'branch' | 'updates' | 'backups' | 'database' | 'branding' | 'reset';

export const TECH_SECTIONS: ReadonlyArray<{ id: TechSection; label: string }> = [
  { id: 'device', label: 'Device' },
  { id: 'sync', label: 'Sync' },
  { id: 'logs', label: 'Logs & diagnostics' },
  { id: 'branch', label: 'Branch & joining' },
  { id: 'updates', label: 'Updates' },
  { id: 'backups', label: 'Backups & history' },
  { id: 'database', label: 'Database' },
  { id: 'branding', label: 'Branding' },
  { id: 'reset', label: 'Reset' },
];

const KEY = 'zaptill.tech.section';

/** The section to open with: the last one picked here, else Device. Never throws. */
export function initialTechSection(): TechSection {
  try {
    const v = localStorage.getItem(KEY);
    if (TECH_SECTIONS.some((s) => s.id === v)) return v as TechSection;
  } catch { /* storage blocked — Device */ }
  return 'device';
}

export function rememberTechSection(id: TechSection): void {
  try { localStorage.setItem(KEY, id); } catch { /* a convenience only */ }
}
