/**
 * PermissionPicker — A490: the ONE place the owner reads and sets what a role (or a person) may see and do.
 *
 * Every group of the catalogue (PERMISSION_GROUPS order) with its words, every key as a checkbox with its label, what it
 * shows and where it applies (Web / Till), a select-all per group (indeterminate when some are on), a search across
 * keys, and a live line per group ("4 of 14 reports"). Used by Settings › Roles and permissions (a role's keys) and a
 * staff card's own rights (the person's keys, against their role's — `baseline` marks what differs).
 *
 * The words come from the cloud (GET /api/staff/permissions, /api/staff/permission-groups) — the same catalogue as
 * lib/permissions.ts, which is the fallback for a cloud that does not answer them yet.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PERMISSIONS, PERMISSION_GROUPS } from '../lib/permissions';

export interface CatalogueKey { key: string; label: string; description: string; group: string; surface: 'web' | 'till' | 'both' }
export interface CatalogueGroup { id: string; label: string; description: string }

interface Client { get: <T>(path: string) => Promise<T> }

/** The catalogue's keys and groups from the cloud, or the local copy while the cloud has none. */
export function usePermissionCatalogue(client: Client): { keys: CatalogueKey[]; groups: CatalogueGroup[]; loading: boolean } {
  const [keys, setKeys] = useState<CatalogueKey[]>([]);
  const [groups, setGroups] = useState<CatalogueGroup[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    Promise.allSettled([
      client.get<CatalogueKey[]>('/api/staff/permissions'),
      client.get<CatalogueGroup[]>('/api/staff/permission-groups'),
    ]).then(([k, g]) => {
      if (!live) return;
      const fromCloud = k.status === 'fulfilled' && Array.isArray(k.value)
        ? k.value.filter((p) => p && typeof p.key === 'string' && typeof p.group === 'string') : [];
      setKeys(fromCloud.length ? fromCloud : PERMISSIONS.map(({ key, label, description, group, surface }) => ({ key, label, description, group, surface })));
      setGroups(g.status === 'fulfilled' && Array.isArray(g.value) && g.value.length ? g.value : PERMISSION_GROUPS.map((x) => ({ ...x })));
      setLoading(false);
    });
    return () => { live = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps — the client is a new object every render (POSAuthContext)
  return { keys, groups, loading };
}

/** "4 of 14 reports" — the live line under a group. */
export function groupSummary(on: number, total: number, label: string): string {
  return `${on} of ${total} ${label.toLowerCase()}`;
}

/** The keys of `checked` that differ from `baseline`: added (on here, off in the role) and taken away. */
export function keyDifferences(checked: ReadonlySet<string>, baseline: ReadonlySet<string>, keys: readonly string[]) {
  const added: string[] = [], removed: string[] = [];
  for (const k of keys) {
    const on = checked.has(k), was = baseline.has(k);
    if (on && !was) added.push(k);
    if (!on && was) removed.push(k);
  }
  return { added, removed };
}

function TriCheckbox({ checked, indeterminate, disabled, onChange, label }: {
  checked: boolean; indeterminate: boolean; disabled?: boolean; onChange: () => void; label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label}
      onChange={onChange} onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 flex-shrink-0 cursor-pointer accent-swift-strong disabled:cursor-default" />
  );
}

function SurfaceBadges({ surface }: { surface: CatalogueKey['surface'] }) {
  const tags = surface === 'both' ? ['Web', 'Till'] : surface === 'till' ? ['Till'] : ['Web'];
  return (
    <span className="inline-flex gap-1 flex-shrink-0">
      {tags.map((t) => (
        <span key={t} className="rounded border border-gray-700 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-gray-400">{t}</span>
      ))}
    </span>
  );
}

export default function PermissionPicker({ keys, groups, checked, onChange, baseline, readOnly, idPrefix = 'perm' }: {
  keys: CatalogueKey[];
  groups: CatalogueGroup[];
  checked: ReadonlySet<string>;
  onChange?: (next: Set<string>) => void;
  /** The role's keys, when this is a person's own rights — a key that differs is marked. */
  baseline?: ReadonlySet<string>;
  readOnly?: boolean;
  idPrefix?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const needle = q.trim().toLowerCase();
  const allOn = checked.has('*');

  const byGroup = useMemo(() => {
    const out = new Map<string, CatalogueKey[]>();
    for (const g of groups) out.set(g.id, []);
    for (const k of keys) {
      if (!out.has(k.group)) out.set(k.group, []);
      out.get(k.group)!.push(k);
    }
    return out;
  }, [keys, groups]);

  const matches = (k: CatalogueKey) => !needle
    || k.label.toLowerCase().includes(needle) || k.description.toLowerCase().includes(needle) || k.key.toLowerCase().includes(needle);

  const set = (mutate: (n: Set<string>) => void) => {
    if (readOnly || !onChange) return;
    const n = new Set(checked);
    n.delete('*');
    mutate(n);
    onChange(n);
  };
  const toggle = (key: string) => set((n) => { if (n.has(key)) n.delete(key); else n.add(key); });
  const toggleGroup = (list: CatalogueKey[]) => set((n) => {
    const every = list.every((k) => n.has(k.key));
    for (const k of list) { if (every) n.delete(k.key); else n.add(k.key); }
  });

  const groupLabel = (id: string) => groups.find((g) => g.id === id);
  const order = [...byGroup.keys()];

  return (
    <div className="space-y-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search permissions…" type="search"
        aria-label="Search permissions" data-testid={`${idPrefix}-search`}
        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-swift focus:outline-none" />
      {allOn && <p className="text-xs text-gray-400">Everything — the owner's role. It cannot be changed.</p>}

      {order.map((gid) => {
        const all = byGroup.get(gid) ?? [];
        const list = all.filter(matches);
        if (!list.length) return null;
        const g = groupLabel(gid) ?? { id: gid, label: gid, description: '' };
        const onCount = all.filter((k) => allOn || checked.has(k.key)).length;
        const visOn = list.filter((k) => allOn || checked.has(k.key)).length;
        const changed = baseline ? all.filter((k) => checked.has(k.key) !== baseline.has(k.key)).length : 0;
        const expanded = needle ? true : !!open[gid];
        return (
          <section key={gid} className="overflow-hidden rounded-xl border border-gray-700" data-testid={`${idPrefix}-group-${gid}`}>
            <div className="flex items-start gap-3 bg-gray-800/50 px-3 py-2.5 sm:px-4">
              <span className="pt-0.5">
                <TriCheckbox label={`All of ${g.label}`} checked={visOn === list.length} indeterminate={visOn > 0}
                  disabled={readOnly || allOn} onChange={() => toggleGroup(list)} />
              </span>
              <button type="button" onClick={() => setOpen((o) => ({ ...o, [gid]: !o[gid] }))} aria-expanded={expanded}
                className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-white">{g.label}</span>
                  {g.description && <span className="block text-xs text-gray-500">{g.description}</span>}
                </span>
                <span className="flex flex-shrink-0 flex-col items-end gap-0.5">
                  <span className="whitespace-nowrap text-xs text-gray-400" data-testid={`${idPrefix}-summary-${gid}`}>{groupSummary(onCount, all.length, g.label)}</span>
                  {changed > 0 && <span className="whitespace-nowrap text-[11px] text-purple-300">{changed} changed for this person</span>}
                  {!needle && <span className="text-[10px] text-gray-500">{expanded ? 'Hide ▲' : 'Show ▼'}</span>}
                </span>
              </button>
            </div>
            {expanded && (
              <ul className="divide-y divide-gray-800">
                {list.map((k) => {
                  const on = allOn || checked.has(k.key);
                  const diff = baseline && !allOn ? (on && !baseline.has(k.key) ? 'added' : !on && baseline.has(k.key) ? 'taken away' : null) : null;
                  const id = `${idPrefix}-${k.key}`;
                  return (
                    <li key={k.key}>
                      <label htmlFor={id} className={`flex gap-3 px-3 py-2.5 sm:px-4 ${readOnly || allOn ? '' : 'cursor-pointer hover:bg-gray-800/40'}`}>
                        <input id={id} type="checkbox" checked={on} disabled={readOnly || allOn} onChange={() => toggle(k.key)}
                          className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-swift-strong disabled:cursor-default" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className={`text-sm ${on ? 'text-white' : 'text-gray-300'}`}>{k.label}</span>
                            <SurfaceBadges surface={k.surface} />
                            {diff && (
                              <span className={`rounded-full px-2 py-px text-[10px] font-medium ${diff === 'added' ? 'bg-purple-500/15 text-purple-300' : 'bg-amber-500/15 text-amber-300'}`}>
                                {diff === 'added' ? 'Added for this person' : 'Taken away for this person'}
                              </span>
                            )}
                          </span>
                          {k.description && <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">{k.description}</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      {needle && order.every((gid) => !(byGroup.get(gid) ?? []).some(matches)) && (
        <p className="py-4 text-center text-sm text-gray-500">No permission matches “{q.trim()}”.</p>
      )}
    </div>
  );
}
