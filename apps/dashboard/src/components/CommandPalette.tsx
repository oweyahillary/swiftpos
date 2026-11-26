/**
 * CommandPalette — A627 (owner, 2026-11-26: "add a search functionality that they can use to navigate the system, web
 * specifically"): a global search for the web dashboard. Press Cmd/Ctrl-K (or the sidebar's Search button, which fires the
 * `zaptill:open-search` event) to open an overlay, type, and jump to any page, report or Settings tab — so a buried switch
 * (e.g. "shift sales" → Business profile, "permissions" → Roles) is one search away.
 *
 * It only offers what the signed-in person may reach: visibleDestinations gates every entry by permission (usePermissions)
 * and the business vertical (useBusiness), exactly as the sidebar does. The page still guards every request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../context/PermissionsContext';
import { useBusiness } from '../context/BusinessContext';
import { visibleDestinations, rankDestinations } from '../lib/commandDestinations';

export default function CommandPalette() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { business } = useBusiness();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const vertical = business?.type ?? '';
  // Recomputed when the palette opens, the query changes or the business changes — permissions are stable within a session.
  const results = useMemo(
    () => (open ? rankDestinations(visibleDestinations(can, vertical), query) : []),
    [open, query, vertical, can],
  );

  const close = useCallback(() => { setOpen(false); setQuery(''); setSel(0); }, []);
  const go = useCallback((to: string) => { close(); navigate(to); }, [close, navigate]);

  // Open on Cmd/Ctrl-K anywhere, and on the sidebar Search button's event. Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('zaptill:open-search', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('zaptill:open-search', onOpen); };
  }, [open, close]);

  // Reset and focus when it opens.
  useEffect(() => {
    if (!open) return;
    setQuery(''); setSel(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Keep the selection in range as results change.
  useEffect(() => { setSel((s) => Math.min(s, Math.max(results.length - 1, 0))); }, [results.length]);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const d = results[sel]; if (d) go(d.to); }
  };

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center p-4 pt-[12vh] bg-black/60 animate-fade-in"
      role="dialog" aria-modal="true" aria-label="Search the dashboard" data-testid="command-palette"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="w-full max-w-xl bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden animate-pop-in">
        <div className="flex items-center gap-3 px-4 border-b border-gray-800">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-gray-500" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setSel(0); }} onKeyDown={onInputKey}
            type="text" placeholder="Search pages, reports and settings…" aria-label="Search the dashboard"
            data-testid="command-palette-input"
            className="flex-1 bg-transparent py-3.5 text-sm text-white placeholder-gray-500 focus:outline-none" />
          <kbd className="hidden sm:inline-flex items-center rounded border border-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">Esc</kbd>
        </div>

        {results.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-gray-500" data-testid="command-palette-empty">
            {query.trim() ? <>Nothing matches “{query.trim()}”.</> : 'Type to search.'}
          </div>
        ) : (
          <ul ref={listRef} className="max-h-[52vh] overflow-y-auto py-2" role="listbox" aria-label="Results">
            {results.map((d, i) => (
              <li key={d.to} data-idx={i} role="option" aria-selected={i === sel}>
                <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(d.to)}
                  data-testid={`command-dest-${d.to}`}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors ${
                    i === sel ? 'bg-action-500/10 text-action-400' : 'text-gray-300 hover:bg-gray-800/50'
                  }`}>
                  <span className="min-w-0 truncate text-sm">{d.label}</span>
                  <span className="flex-shrink-0 text-[11px] text-gray-500">{d.group}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-gray-800 text-[11px] text-gray-500">
          <span>↑↓ to move · ↵ to open</span>
          <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}
