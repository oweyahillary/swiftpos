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
 *
 * A595 (docs/PERMISSIONS-AUDIT.md 6.4): within a group the keys stand in three parts — See, Do, Approve (the cloud's
 * `kind`, else permissionKind). A key that was split shows its PARTS indented under it ("includes"); a part with two
 * parents (inventory.reorder, staff.contacts) under its first one only, never also on its own. Ticking a parent that was
 * off ticks its parts (what the old box always gave); unticking it unticks them (a part another held parent also brings
 * stays); each part can then be ticked or unticked alone. Keys that show personal data carry a "Personal data" badge.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PERMISSIONS, PERMISSION_GROUPS, PERSONAL_KEYS, parentOf, partsOf, permissionKind, type PermissionKind } from '@zaptill/core/permissions';
import { permissionWords, permissionGroupWords } from '@zaptill/core/businessTerms';   // A573

export interface CatalogueKey {
  key: string; label: string; description: string; group: string; surface: 'web' | 'till' | 'both';
  /** A595 (the cloud's, from GET /api/staff/permissions): a part names its parent (first one); a parent lists its parts. */
  view?: boolean; personal?: boolean; parent?: string | null; parts?: string[]; kind?: PermissionKind;
}
export interface CatalogueGroup { id: string; label: string; description: string }

interface Client { get: <T>(path: string) => Promise<T> }

/**
 * The catalogue's keys and groups from the cloud, or the local copy while the cloud has none. A573: `businessType` — the
 * words a shop reads in place of the catalogue's menu / kitchen / table words (lib/businessTerms.ts permissionWords; the
 * catalogue's own words are frozen by migration 134). Not given, or a restaurant: the catalogue's words.
 */
export function usePermissionCatalogue(client: Client, businessType?: string | null): { keys: CatalogueKey[]; groups: CatalogueGroup[]; loading: boolean } {
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
      setKeys(fromCloud.length ? fromCloud : PERMISSIONS.map(({ key, label, description, group, surface, view, personal }) => ({
        key, label, description, group, surface, view: view === true, personal: personal === true,
        parent: parentOf(key), parts: [...partsOf(key)], kind: permissionKind(key),
      })));
      setGroups(g.status === 'fulfilled' && Array.isArray(g.value) && g.value.length ? g.value : PERMISSION_GROUPS.map((x) => ({ ...x })));
      setLoading(false);
    });
    return () => { live = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps — the client is a new object every render (POSAuthContext)
  const worded = useMemo(() => ({
    keys: keys.map((k) => ({ ...k, ...permissionWords(businessType, k.key, k.label, k.description) })),
    groups: groups.map((g) => ({ ...g, ...permissionGroupWords(businessType, g.id, g.label, g.description) })),
  }), [keys, groups, businessType]);
  return { ...worded, loading };
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

/** A595: the three parts of a group, in order. */
export const KIND_SECTIONS: ReadonlyArray<{ kind: PermissionKind; label: string; hint: string }> = [
  { kind: 'see', label: 'See', hint: 'lists, reports and figures' },
  { kind: 'do', label: 'Do', hint: 'add, change, sell and record' },
  { kind: 'approve', label: 'Approve', hint: 'with their PIN, or someone else\'s request' },
];

/** A595: a key's See / Do / Approve — the cloud's word when it sent one. */
export const kindOf = (k: Pick<CatalogueKey, 'key' | 'kind'>): PermissionKind =>
  k.kind === 'see' || k.kind === 'do' || k.kind === 'approve' ? k.kind : permissionKind(k.key);
/** A595: does this key show or set personal data (the badge)? */
export const isPersonal = (k: Pick<CatalogueKey, 'key' | 'personal'>): boolean =>
  typeof k.personal === 'boolean' ? k.personal : PERSONAL_KEYS.includes(k.key);
/** A595: the parent a part is listed under (its first), or null. */
export const displayParentOf = (k: Pick<CatalogueKey, 'key' | 'parent'>): string | null =>
  k.parent !== undefined ? (k.parent || null) : parentOf(k.key);
/** A595: every part of a key — ticking it ticks them all, also one listed under its other parent (staff.contacts). */
export const allPartsOf = (k: Pick<CatalogueKey, 'parts'> | undefined, key: string): readonly string[] =>
  k && Array.isArray(k.parts) ? k.parts : partsOf(key);

/**
 * A595: the keys after ticking or unticking `key`. Ticking a key that was off adds it and its parts; unticking takes
 * them away too — except a part another key still ticked also brings (staff.contacts: seeing OR editing staff;
 * inventory.reorder: receiving OR adjusting). A part (no parts of its own) is ticked or unticked alone. Never '*'.
 */
export function toggleKey(checked: ReadonlySet<string>, key: string, keys: readonly CatalogueKey[] = []): Set<string> {
  const byKey = new Map(keys.map((k) => [k.key, k]));
  const parts = (x: string) => allPartsOf(byKey.get(x), x);
  const n = new Set(checked);
  n.delete('*');
  if (n.has(key)) {
    n.delete(key);
    for (const c of parts(key)) {
      const kept = [...n].some((other) => other !== key && parts(other).includes(c));
      if (!kept) n.delete(c);
    }
  } else {
    n.add(key);
    for (const c of parts(key)) n.add(c);
  }
  return n;
}

export interface ArrangedRow { key: CatalogueKey; parts: CatalogueKey[] }

/**
 * A595: a group's keys as the screen lists them — See, Do, Approve; in each, the top-level keys with the parts listed
 * under them. `list` is what is shown (a search), `all` the whole group: a part matched alone brings its parent along.
 */
export function arrangeGroup(list: readonly CatalogueKey[], all: readonly CatalogueKey[] = list): Array<{ kind: PermissionKind; rows: ArrangedRow[] }> {
  const present = new Set(all.map((k) => k.key));
  const inList = new Set(list.map((k) => k.key));
  const under = new Map<string, CatalogueKey[]>();
  const top: CatalogueKey[] = [];
  for (const k of list) {
    const p = displayParentOf(k);
    if (p && p !== k.key && present.has(p)) {
      if (!under.has(p)) under.set(p, []);
      under.get(p)!.push(k);
    } else top.push(k);
  }
  for (const p of under.keys()) {
    if (inList.has(p)) continue;
    const pk = all.find((k) => k.key === p);
    if (pk) top.push(pk);
  }
  const order = new Map(all.map((k, i) => [k.key, i]));
  top.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  return KIND_SECTIONS.map(({ kind }) => ({
    kind,
    rows: top.filter((k) => kindOf(k) === kind).map((k) => ({ key: k, parts: under.get(k.key) ?? [] })),
  })).filter((s) => s.rows.length > 0);
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
  const tags = surface === 'both' ? ['Web', 'POS'] : surface === 'till' ? ['POS'] : ['Web'];
  return (
    <span className="inline-flex gap-1 flex-shrink-0">
      {tags.map((t) => (
        <span key={t} className="rounded border border-gray-700 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-gray-400">{t}</span>
      ))}
    </span>
  );
}

export default function PermissionPicker({ keys, groups, checked, onChange, baseline, readOnly, idPrefix = 'perm', defaultOpen }: {
  keys: CatalogueKey[];
  groups: CatalogueGroup[];
  checked: ReadonlySet<string>;
  onChange?: (next: Set<string>) => void;
  /** The role's keys, when this is a person's own rights — a key that differs is marked. */
  baseline?: ReadonlySet<string>;
  readOnly?: boolean;
  idPrefix?: string;
  /** Every group starts open (a test, a short read-only list). */
  defaultOpen?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const needle = q.trim().toLowerCase();
  const allOn = checked.has('*');

  // A595: a part is counted and listed in its parent's group.
  const byGroup = useMemo(() => {
    const groupOf = new Map(keys.map((k) => [k.key, k.group]));
    const out = new Map<string, CatalogueKey[]>();
    for (const g of groups) out.set(g.id, []);
    for (const k of keys) {
      const p = displayParentOf(k);
      const gid = (p && groupOf.get(p)) || k.group;
      if (!out.has(gid)) out.set(gid, []);
      out.get(gid)!.push(k);
    }
    return out;
  }, [keys, groups]);

  const hit = (k: CatalogueKey) => !needle
    || k.label.toLowerCase().includes(needle) || k.description.toLowerCase().includes(needle) || k.key.toLowerCase().includes(needle);
  // A matching parent shows with all its parts; a matching part with its parent (arrangeGroup).
  const visible = (all: CatalogueKey[]) => {
    if (!needle) return all;
    const shown = new Set(all.filter(hit).map((k) => k.key));
    for (const k of all) { const p = displayParentOf(k); if (p && shown.has(p)) shown.add(k.key); }
    return all.filter((k) => shown.has(k.key));
  };

  const set = (next: (n: Set<string>) => Set<string>) => {
    if (readOnly || !onChange) return;
    const n = new Set(checked);
    n.delete('*');
    const out = next(n);
    out.delete('*');
    onChange(out);
  };
  const toggle = (key: string) => set((n) => toggleKey(n, key, keys));
  const toggleGroup = (list: CatalogueKey[]) => set((n) => {
    const every = list.every((k) => n.has(k.key));
    for (const k of list) { if (every) n.delete(k.key); else n.add(k.key); }
    return n;
  });

  const groupLabel = (id: string) => groups.find((g) => g.id === id);
  const order = [...byGroup.keys()];

  const row = (k: CatalogueKey, part: boolean) => {
    const on = allOn || checked.has(k.key);
    let diff: 'added' | 'taken away' | null = null;
    if (baseline && !allOn) {
      if (on && !baseline.has(k.key)) diff = 'added';
      else if (!on && baseline.has(k.key)) diff = 'taken away';
    }
    const id = `${idPrefix}-${k.key}`;
    return (
      <label htmlFor={id} data-testid={part ? `${idPrefix}-part-${k.key}` : undefined}
        className={`flex gap-3 py-2.5 pr-3 sm:pr-4 ${part ? 'pl-8 sm:pl-11' : 'pl-3 sm:pl-4'} ${readOnly || allOn ? '' : 'cursor-pointer hover:bg-gray-800/40'}`}>
        <input id={id} type="checkbox" checked={on} disabled={readOnly || allOn} onChange={() => toggle(k.key)}
          className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-swift-strong disabled:cursor-default" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {part && <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">includes</span>}
            <span className={`break-words text-sm ${on ? 'text-white' : 'text-gray-300'}`}>{k.label}</span>
            <SurfaceBadges surface={k.surface} />
            {isPersonal(k) && (
              <span data-testid={`${idPrefix}-personal-${k.key}`} title="Shows or sets personal data: phone numbers, e-mails, PINs or pay"
                className="rounded-full bg-rose-500/15 px-2 py-px text-[10px] font-medium text-rose-300">Personal data</span>
            )}
            {diff && (
              <span className={`rounded-full px-2 py-px text-[10px] font-medium ${diff === 'added' ? 'bg-purple-500/15 text-purple-300' : 'bg-amber-500/15 text-amber-300'}`}>
                {diff === 'added' ? 'Added for this person' : 'Taken away for this person'}
              </span>
            )}
          </span>
          {k.description && <span className="mt-0.5 block break-words text-xs leading-relaxed text-gray-500">{k.description}</span>}
        </span>
      </label>
    );
  };

  return (
    <div className="space-y-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search permissions…" type="search"
        aria-label="Search permissions" data-testid={`${idPrefix}-search`}
        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-swift focus:outline-none" />
      {allOn && <p className="text-xs text-gray-400">Everything — the owner's role. It cannot be changed.</p>}

      {order.map((gid) => {
        const all = byGroup.get(gid) ?? [];
        const list = visible(all);
        if (!list.length) return null;
        const g = groupLabel(gid) ?? { id: gid, label: gid, description: '' };
        const onCount = all.filter((k) => allOn || checked.has(k.key)).length;
        const visOn = list.filter((k) => allOn || checked.has(k.key)).length;
        const changed = baseline ? all.filter((k) => checked.has(k.key) !== baseline.has(k.key)).length : 0;
        const expanded = needle || defaultOpen ? true : !!open[gid];
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
                  {!needle && !defaultOpen && <span className="text-[10px] text-gray-500">{expanded ? 'Hide ▲' : 'Show ▼'}</span>}
                </span>
              </button>
            </div>
            {expanded && arrangeGroup(list, all).map(({ kind, rows }) => {
              const sec = KIND_SECTIONS.find((s) => s.kind === kind)!;
              return (
                <div key={kind} data-testid={`${idPrefix}-kind-${gid}-${kind}`} className="border-t border-gray-800">
                  <p className="bg-gray-900/60 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 sm:px-4">
                    {sec.label} <span className="font-normal normal-case tracking-normal text-gray-600">· {sec.hint}</span>
                  </p>
                  <ul className="divide-y divide-gray-800">
                    {rows.map(({ key: k, parts }) => (
                      <li key={k.key}>
                        {row(k, false)}
                        {parts.length > 0 && (
                          <ul className="border-t border-gray-800/60" data-testid={`${idPrefix}-parts-${k.key}`}>
                            {parts.map((c) => <li key={c.key}>{row(c, true)}</li>)}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}
      {needle && order.every((gid) => !(byGroup.get(gid) ?? []).some(hit)) && (
        <p className="py-4 text-center text-sm text-gray-500">No permission matches “{q.trim()}”.</p>
      )}
    </div>
  );
}
