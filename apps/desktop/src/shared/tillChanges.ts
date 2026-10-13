/**
 * tillChanges.ts — A448: a manager's change made on a till is saved there first and sent to the cloud later; the cloud
 * applies it, recognises it as already there, or holds it for the owner when someone else changed the same thing.
 *
 * Owner, 2026-10-11/12: "a totally offline till can't add another printer — that's bad … cloud should never block a till
 * from working … cloud and local instance complement one another but none is superior unless an override is done";
 * a clash: "if they are the same keep them, if not notify the owner requesting approval"; "offline supersedes online when it
 * comes to PIN change".
 *
 * ONE set of rules, run by the till (what it may record and how it shows) and the cloud (what it applies): which fields each
 * kind of change carries and how each is cleaned, and how a change compares with what the cloud holds. Pure; ONE file,
 * copied to the till (main) and the cloud (check-shared-sync).
 */

export type ChangeEntity = 'station' | 'category' | 'product' | 'staff' | 'staff_pin';
export type ChangeOp = 'create' | 'update' | 'delete';
export const CHANGE_ENTITIES: ChangeEntity[] = ['station', 'category', 'product', 'staff', 'staff_pin'];

type Clean = (v: unknown) => { ok: true; value: unknown } | { ok: false; error: string };
const ok = (value: unknown) => ({ ok: true as const, value });
const no = (error: string) => ({ ok: false as const, error });

const text = (max: number, required = false): Clean => (v) => {
  if (v === null || v === undefined) return required ? no('is required') : ok(null);
  const s = String(v).trim().slice(0, max);
  return required && !s ? no('cannot be empty') : ok(s || null);
};
const money: Clean = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? ok(Math.round(n * 100) / 100) : no('must be an amount of 0 or more');
};
const int: Clean = (v) => ok(Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const bool: Clean = (v) => ok(v === true || v === 1 || v === 'true');
const triBool: Clean = (v) => ok(v === null || v === undefined ? null : v === true || v === 1 || v === 'true');
const oneOf = (values: string[]): Clean => (v) => (values.includes(String(v)) ? ok(String(v)) : no(`must be one of ${values.join(', ')}`));
const uuidOrNull: Clean = (v) => (v === null || v === undefined || v === '' ? ok(null)
  : /^[0-9a-f-]{36}$/i.test(String(v)) ? ok(String(v)) : no('is not a valid id'));
const days: Clean = (v) => {
  if (v === null || v === undefined || v === '') return ok(null);
  let a: unknown = v;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return no('must be a list of days'); } }
  if (!Array.isArray(a)) return no('must be a list of days');
  const d = [...new Set(a.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
  return ok(d.length === 0 || d.length === 7 ? null : d);
};

export interface EntitySpec {
  /** The cloud table it changes. */
  table: string;
  /** Any one of these permission keys may make it (the cloud's own routes use the same). */
  permissions: string[];
  /** Fields a change may carry, each cleaned. */
  fields: Record<string, Clean>;
  /** Fields a create must carry. */
  required: string[];
  /** Fields that identify "the same thing" when a create meets one the cloud already has under another id. */
  sameBy: string[];
  /** Column defaults the cloud fills on a create. */
  defaults: Record<string, unknown>;
}

export const ENTITY_SPECS: Record<ChangeEntity, EntitySpec> = {
  station: {
    table: 'print_stations', permissions: ['stations.manage', 'products.manage'],
    fields: { name: text(60, true), kind: oneOf(['kitchen', 'dispatch', 'receipt']), sort_order: int, active: bool },
    required: ['name', 'kind'], sameBy: ['name'], defaults: { active: true, sort_order: 0 },
  },
  category: {
    table: 'categories', permissions: ['products.manage'],
    fields: { name: text(80, true), color: text(20), icon: text(40), sort_order: int, status: oneOf(['active', 'inactive']), is_kitchen: bool },
    required: ['name'], sameBy: ['name'], defaults: { status: 'active', sort_order: 0, is_kitchen: false },
  },
  product: {
    table: 'products', permissions: ['products.manage'],
    fields: {
      name: text(120, true), description: text(500), base_price: money, category_id: uuidOrNull,
      status: oneOf(['active', 'inactive']), show_days: days, barcode: text(64), plu_code: text(16), is_kitchen: triBool,
      track_stock: bool, cost_price: money,
    },
    required: ['name', 'base_price'], sameBy: ['name', 'category_id'],
    defaults: { status: 'active', track_stock: true, has_variants: false, has_modifiers: false, sold_by: 'each', unit_label: 'pc',
      source: 'purchased', tax_type: 'B', pieces_per_unit: 1 },
  },
  // A cashier added on a till (offline too): they sign in on that till at once; the cloud adds them to the till's branch.
  // A459 (owner, 2026-10-13: rename, role and deactivate offline — "yes, all three"): a staff member is also UPDATED from a
  // till — name, role, active / inactive. A PIN is never part of an update (staff_pin is).
  staff: {
    table: 'users', permissions: ['staff.manage'],
    fields: { name: text(80, true), role_id: uuidOrNull, status: oneOf(['active', 'inactive']),
      pin: (v) => (/^\d{4,6}$/.test(String(v ?? '')) ? ok(String(v)) : no('must be 4–6 digits')) },
    required: ['name', 'role_id', 'pin'], sameBy: [], defaults: { status: 'active' },
  },
  staff_pin: {
    table: 'users', permissions: ['staff.manage'],
    fields: { pin: (v) => (/^\d{4,6}$/.test(String(v ?? '')) ? ok(String(v)) : no('must be 4–6 digits')) },
    required: ['pin'], sameBy: [], defaults: {},
  },
};

export interface TillChange {
  id: string;               // the till's own id for this change (a replay is recognised by it)
  entity: ChangeEntity;
  op: ChangeOp;
  entity_id: string;        // the thing it changes; a create brings its own new id
  base: Record<string, unknown> | null;      // update / delete: the fields as the till saw them before
  data: Record<string, unknown>;             // create / update: the till's values (cleaned)
  made_by: string | null;   // who made it on the till (their permission is checked by the cloud)
  made_by_name: string | null;
  made_at: string;
}

/** A change from a till (or from a screen on it) → a clean change, or the reason it is not one. */
export function cleanChange(raw: any): { ok: true; change: TillChange } | { ok: false; error: string } {
  const r = raw ?? {};
  const entity = String(r.entity ?? '') as ChangeEntity;
  const spec = ENTITY_SPECS[entity];
  if (!spec) return { ok: false, error: 'unknown kind of change' };
  const op = String(r.op ?? '') as ChangeOp;
  if (!['create', 'update', 'delete'].includes(op)) return { ok: false, error: 'unknown operation' };
  if (entity === 'staff_pin' && op !== 'update') return { ok: false, error: 'a PIN is only changed' };
  if (entity === 'staff' && op === 'delete') return { ok: false, error: 'a staff member is deactivated, never deleted' };
  const id = String(r.id ?? ''), entityId = String(r.entity_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(entityId)) return { ok: false, error: 'a change needs valid ids' };
  const data: Record<string, unknown> = {};
  if (op !== 'delete') {
    for (const [k, v] of Object.entries(r.data ?? {})) {
      const f = spec.fields[k];
      if (!f) continue;   // a field this kind of change does not carry is ignored, never stored
      const c = f(v);
      if (!c.ok) return { ok: false, error: `${k} ${(c as { error: string }).error}` };
      data[k] = (c as { value: unknown }).value;
    }
    if (entity === 'staff' && op === 'update') delete data.pin;   // A459: a PIN changes only as staff_pin
    if (op === 'create') for (const k of spec.required) if (data[k] === undefined || data[k] === null || data[k] === '') return { ok: false, error: `${k} is required` };
    if (op === 'update' && !Object.keys(data).length) return { ok: false, error: 'nothing to change' };
  }
  const base: Record<string, unknown> = {};
  if (r.base && typeof r.base === 'object') for (const [k, v] of Object.entries(r.base)) if (spec.fields[k] || k === 'id') base[k] = v;
  return { ok: true, change: {
    id, entity, op, entity_id: entityId, base: op === 'create' ? null : base, data,
    made_by: r.made_by ? String(r.made_by) : null, made_by_name: r.made_by_name ? String(r.made_by_name).slice(0, 100) : null,
    made_at: typeof r.made_at === 'string' ? r.made_at : new Date().toISOString(),
  } };
}

/** Two stored values the same? Numbers by value, text trimmed, lists by content (order-free for days), null ≈ ''. */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => {
    if (v === undefined || v === null || v === '') return '∅';
    if (typeof v === 'string' && /^\[.*\]$/.test(v.trim())) { try { return norm(JSON.parse(v)); } catch { /* text */ } }
    if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim()))) return String(Math.round(Number(v) * 100) / 100);
    return String(v).trim();
  };
  return norm(a) === norm(b);
}

/** One field of an entity the same on both sides, each cleaned by the field's own rule first (the till keeps true as 1,
 *  days as JSON text; the cloud as true and an array). */
export function sameField(entity: ChangeEntity, field: string, a: unknown, b: unknown): boolean {
  const f = ENTITY_SPECS[entity].fields[field];
  const clean = (v: unknown) => { if (!f) return v; const c = f(v); return c.ok ? (c as { value: unknown }).value : v; };
  return sameValue(clean(a), clean(b));
}

export type Verdict = { verdict: 'apply' } | { verdict: 'identical' } | { verdict: 'clash'; fields: string[] };

/**
 * An update, against what the cloud holds now:
 *   the cloud already holds the till's values                 → identical (the same change made elsewhere, or a replay)
 *   for every changed field the cloud still holds the base    → apply (nobody else changed them)
 *   otherwise                                                 → clash: the fields someone else changed differently
 * staff_pin never clashes: a PIN set on a till wins (the owner's rule) — its only refusal is a PIN another person has.
 */
export function judgeUpdate(entity: ChangeEntity, current: Record<string, unknown>, base: Record<string, unknown> | null,
  data: Record<string, unknown>): Verdict {
  if (entity === 'staff_pin') return { verdict: 'apply' };
  const keys = Object.keys(data);
  const same = (k: string, a: unknown, b: unknown) => sameField(entity, k, a, b);
  if (keys.every((k) => same(k, current[k], data[k]))) return { verdict: 'identical' };
  const clash = keys.filter((k) => !same(k, current[k], data[k]) && !same(k, current[k], base?.[k]));
  return clash.length ? { verdict: 'clash', fields: clash } : { verdict: 'apply' };
}

/** A create, against a row the cloud already has (same id, or the same thing by `sameBy`): identical, or a clash. */
export function judgeCreate(entity: ChangeEntity, existing: Record<string, unknown>, data: Record<string, unknown>): Verdict {
  // The same thing made in two places: "grill" on a till is the cloud's "Grill" (the cloud found it by name, any case).
  const sameName = (x: unknown, y: unknown) => String(x ?? '').trim().toLowerCase() === String(y ?? '').trim().toLowerCase();
  const differ = Object.keys(data).filter((k) => !(k === 'name' ? sameName(existing[k], data[k]) : sameField(entity, k, existing[k], data[k])));
  return differ.length ? { verdict: 'clash', fields: differ } : { verdict: 'identical' };
}

/** Words for a change, for the owner's approval list and the till. */
export function describeChange(c: Pick<TillChange, 'entity' | 'op' | 'data'>, label?: string | null): string {
  const what = { station: 'print station', category: 'category', product: 'product', staff: 'staff member', staff_pin: 'PIN' }[c.entity];
  const name = label || (c.data?.name as string) || '';
  if (c.entity === 'staff_pin') return `PIN for ${name || 'a staff member'}`;
  return `${c.op === 'create' ? 'New' : c.op === 'delete' ? 'Delete' : 'Change'} ${what}${name ? ` "${name}"` : ''}`;
}
