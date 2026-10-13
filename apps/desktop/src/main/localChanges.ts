/**
 * localChanges.ts — A448: a manager's change on the till works at once, offline too, and reaches the cloud later.
 *
 * Owner, 2026-10-11/12: "a totally offline till can't add another printer — that's bad; they should be able to work
 * independently; cloud should never block a till from working … cloud and local instance complement one another but none
 * is superior unless an override is done"; a clash: "if they are the same keep them, if not notify the owner requesting
 * approval"; "offline supersedes online when it comes to PIN change".
 *
 * A change (a print station, a category, a product, a cashier, a PIN — rules: tillChanges.ts, shared with the cloud) is:
 *   1. written to this till's own tables AT ONCE (the printer prints, the item sells, the cashier signs in) — `applyLocal`;
 *   2. queued in `local_changes` with the values it replaced (`base`);
 *   3. sent to the cloud (POST /api/changes, through the branch server on a till behind one) now and on every beat until
 *      answered: applied / identical (done), awaiting (the owner decides — this till keeps its own meanwhile), refused
 *      (the reason is shown; the cloud's comes back on the next pull);
 *   4. laid back over every pull while it waits (`overlayLocalChanges`), so a pull never undoes it.
 * A till behind a branch server also hands each change to the server (/node/changes): the server applies it too, so the
 * branch's other tills have it with no internet at all, and sends it to the cloud itself (the cloud recognises a change
 * sent twice by its id).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { cleanChange, ENTITY_SPECS, describeChange, type TillChange, type ChangeEntity } from './tillChanges';

export type LocalState = 'pending' | 'awaiting' | 'done' | 'refused' | 'rejected';
export interface LocalChangeRow {
  id: string; entity: ChangeEntity; op: string; entity_id: string; base: string | null; data: string;
  made_by: string | null; made_by_name: string | null; made_at: string; state: LocalState; message: string | null;
  canonical_id: string | null; tries: number; updated_at: string;
}

/** Wrap / unwrap a secret kept on this till (a PIN waiting to be sent) — safeStorage in the app, plain in tests. */
/** wrap/unwrap: a PIN held in the queue. seal: a PIN hash in this till's staff list (branch_staff.pin_hash_enc — bare
 *  safeStorage base64, what branchStaff reads; the queue's `enc:` form does not match there). */
export interface Secrets { wrap: (s: string) => string; unwrap: (s: string) => string; seal: (s: string) => string }

export function ensureTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS local_changes (
    id TEXT PRIMARY KEY, entity TEXT NOT NULL, op TEXT NOT NULL, entity_id TEXT NOT NULL, base TEXT, data TEXT NOT NULL,
    made_by TEXT, made_by_name TEXT, made_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', message TEXT,
    canonical_id TEXT, tries INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS local_changes_open ON local_changes (state, made_at)`);
}

// ── This till's tables, in the change's words ──────────────────────────────────────────────────────────────────────

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const bit = (v: unknown) => (v === null || v === undefined ? null : v ? 1 : 0);

/** The local row of a thing, in the change's field names (what `base` records). */
export function readLocal(db: Database.Database, entity: ChangeEntity, id: string): Record<string, unknown> | null {
  try {
    if (entity === 'station') {
      const r = db.prepare(`SELECT name, kind, sort_order, active FROM print_stations WHERE id = ?`).get(id) as any;
      return r ? { name: r.name, kind: r.kind, sort_order: r.sort_order, active: !!r.active } : null;
    }
    if (entity === 'category') {
      const r = db.prepare(`SELECT name, color, icon, sort_order, status, is_kitchen FROM categories WHERE id = ?`).get(id) as any;
      return r ? { ...r, is_kitchen: !!r.is_kitchen } : null;
    }
    if (entity === 'product') {
      const r = db.prepare(`SELECT name, description, base_price, category_id, status, show_days, barcode, plu, is_kitchen, track_stock FROM products WHERE id = ?`).get(id) as any;
      if (!r) return null;
      let days: unknown = null; try { days = r.show_days ? JSON.parse(r.show_days) : null; } catch { days = null; }
      return { name: r.name, description: r.description, base_price: r.base_price, category_id: r.category_id, status: r.status,
        show_days: days, barcode: r.barcode, plu_code: r.plu, is_kitchen: r.is_kitchen === null ? null : !!r.is_kitchen, track_stock: !!r.track_stock };
    }
    if (entity === 'staff' || entity === 'staff_pin') {
      const r = db.prepare(`SELECT name, role_name, status FROM branch_staff WHERE staff_id = ?`).get(id) as any;
      if (!r) return null;
      // A459: the role by its id, from the roles this till saved (what the cloud compares an update against).
      let roleId: string | null = null;
      try {
        const roles = JSON.parse((db.prepare(`SELECT value FROM maintenance_state WHERE key = 'roles_cache'`).get() as any)?.value ?? '[]') as any[];
        roleId = roles.find((x) => String(x?.name ?? '').toLowerCase() === String(r.role_name ?? '').toLowerCase())?.id ?? null;
      } catch { roleId = null; }
      return { name: r.name, status: r.status ?? 'active', ...(roleId ? { role_id: roleId } : {}) };
    }
  } catch { /* a table not there yet */ }
  return null;
}

/** Write the change to this till's own tables. `local` carries what only the till needs (a PIN's hash, a role's name). */
export function applyLocal(db: Database.Database, c: Pick<TillChange, 'entity' | 'op' | 'entity_id' | 'data'>,
  local: { pinHashEnc?: string | null; roleName?: string | null; permissions?: unknown; branchId?: string | null } = {}): void {
  const d = c.data ?? {};
  const set = (table: string, cols: Record<string, unknown>) => {
    const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (!keys.length) return;
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...Object.fromEntries(keys.map((k) => [k, cols[k]])), id: c.entity_id });
  };
  if (c.entity === 'station') {
    if (c.op === 'delete') { db.prepare(`DELETE FROM category_stations WHERE station_id = ?`).run(c.entity_id); db.prepare(`DELETE FROM print_stations WHERE id = ?`).run(c.entity_id); return; }
    if (c.op === 'create') db.prepare(`INSERT OR IGNORE INTO print_stations (id, name, kind, sort_order, active, synced_at) VALUES (?, ?, ?, ?, 1, NULL)`)
      .run(c.entity_id, d.name, d.kind ?? 'kitchen', Number(d.sort_order) || 0);
    set('print_stations', { name: d.name, kind: d.kind, sort_order: d.sort_order, active: d.active === undefined ? undefined : bit(d.active) });
    return;
  }
  if (c.entity === 'category') {
    if (c.op === 'delete') { db.prepare(`DELETE FROM category_stations WHERE category_id = ?`).run(c.entity_id); db.prepare(`DELETE FROM categories WHERE id = ?`).run(c.entity_id); return; }
    if (c.op === 'create') db.prepare(`INSERT OR IGNORE INTO categories (id, name, status, sort_order) VALUES (?, ?, 'active', 0)`).run(c.entity_id, d.name);
    set('categories', { name: d.name, color: d.color, icon: d.icon, sort_order: d.sort_order, status: d.status,
      is_kitchen: d.is_kitchen === undefined ? undefined : bit(d.is_kitchen) });
    return;
  }
  if (c.entity === 'product') {
    if (c.op === 'delete') { set('products', { status: 'inactive' }); return; }
    if (c.op === 'create') db.prepare(`INSERT OR IGNORE INTO products (id, name, base_price, status, track_stock, has_variants, has_modifiers) VALUES (?, ?, ?, 'active', 1, 0, 0)`)
      .run(c.entity_id, d.name, Number(d.base_price) || 0);
    set('products', { name: d.name, description: d.description, base_price: d.base_price, category_id: d.category_id, status: d.status,
      show_days: d.show_days === undefined ? undefined : json(d.show_days), barcode: d.barcode, plu: d.plu_code,
      is_kitchen: d.is_kitchen === undefined ? undefined : bit(d.is_kitchen), track_stock: d.track_stock === undefined ? undefined : bit(d.track_stock) });
    return;
  }
  if (c.entity === 'staff' && c.op === 'update') {
    // A459: a rename, a new role (its name and permissions from the roles this till saved) or (de)activation — here at once.
    // Inactive: kept on this till's list (so it can be undone) but no longer signs in here (branchStaff filters status),
    // and its saved sign-in is dropped.
    const cols: Record<string, unknown> = { name: d.name, status: d.status };
    if (d.role_id !== undefined) {
      try {
        const roles = JSON.parse((db.prepare(`SELECT value FROM maintenance_state WHERE key = 'roles_cache'`).get() as any)?.value ?? '[]') as any[];
        const role = roles.find((x) => x?.id === d.role_id);
        if (role) {
          const perms: Record<string, boolean> = {};
          for (const p of (role.permissions ?? role.role_permissions ?? [])) { const k = p?.key ?? p?.permissions?.key; if (k) perms[k] = true; }
          cols.role_name = role.name; cols.permissions = JSON.stringify(perms);
        }
      } catch { /* the role stays until the next list */ }
    }
    const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (keys.length) db.prepare(`UPDATE branch_staff SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE staff_id = @id`)
      .run({ ...Object.fromEntries(keys.map((k) => [k, cols[k]])), now: new Date().toISOString(), id: c.entity_id });
    if (d.status === 'inactive') { try { db.prepare(`DELETE FROM staff_pin_cache WHERE staff_id = ?`).run(c.entity_id); } catch { /* none */ } }
    return;
  }
  if ((c.entity === 'staff' || c.entity === 'staff_pin') && local.pinHashEnc) {
    if (c.entity === 'staff') {
      db.prepare(`INSERT OR REPLACE INTO branch_staff (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(c.entity_id, d.name, local.roleName ?? null, local.branchId ?? '',
        JSON.stringify(local.permissions ?? {}), local.pinHashEnc, new Date().toISOString());
    } else {
      db.prepare(`UPDATE branch_staff SET pin_hash_enc = ?, updated_at = ? WHERE staff_id = ?`).run(local.pinHashEnc, new Date().toISOString(), c.entity_id);
      // A PIN set here supersedes the one this till saved from an earlier sign-in (owner's rule).
      try { db.prepare(`UPDATE staff_pin_cache SET pin_hash_enc = ? WHERE staff_id = ?`).run(local.pinHashEnc, c.entity_id); } catch { /* none */ }
    }
  }
}

// ── Recording a change ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RecordInput { entity: ChangeEntity; op: 'create' | 'update' | 'delete'; entity_id?: string; data?: Record<string, unknown> }
export interface Maker { id: string | null; name: string | null }

/**
 * Record a change made on this till: applied here at once, queued for the cloud. A change to something that already has
 * a change waiting joins it (a new product edited before it reached the cloud is still one create). Returns the change
 * (with its entity id — a create's new id) or why it was refused.
 */
export function recordChange(db: Database.Database, input: RecordInput, maker: Maker, secrets: Secrets,
  local: { roleName?: string | null; permissions?: unknown; branchId?: string | null } = {}, now = new Date().toISOString()):
  { ok: true; change: TillChange } | { ok: false; error: string } {
  ensureTable(db);
  const entityId = input.entity_id || randomUUID();
  const c = cleanChange({ id: randomUUID(), entity: input.entity, op: input.op, entity_id: entityId, data: input.data ?? {},
    base: input.op === 'create' ? null : readLocal(db, input.entity, entityId), made_by: maker.id, made_by_name: maker.name, made_at: now });
  if (!c.ok) return { ok: false, error: (c as { error: string }).error };
  const change = (c as { change: TillChange }).change;
  if (input.op !== 'create' && input.entity !== 'staff_pin' && !readLocal(db, input.entity, entityId)) return { ok: false, error: 'that is not on this till' };

  // A PIN never sits in the queue in the clear: its hash is applied here, the PIN itself kept wrapped until sent.
  let pinHashEnc: string | null = null;
  const stored: Record<string, unknown> = { ...change.data };
  if (change.entity === 'staff' || change.entity === 'staff_pin') {
    pinHashEnc = secrets.seal(bcrypt.hashSync(String(change.data.pin), 10));
    stored.pin = secrets.wrap(String(change.data.pin));
    stored.pin_hash_enc = pinHashEnc;
    stored.role_name = local.roleName ?? null; stored.permissions = local.permissions ?? null; stored.branch_id = local.branchId ?? null;
  }

  db.transaction(() => {
    const open = db.prepare(`SELECT * FROM local_changes WHERE entity = ? AND entity_id = ? AND state = 'pending' ORDER BY made_at DESC LIMIT 1`)
      .get(change.entity, entityId) as LocalChangeRow | undefined;
    if (open && change.op !== 'delete' && (open.op === 'create' || open.op === 'update') && change.entity !== 'staff_pin') {
      // Joins the change still waiting: one create (or one update, with the base it started from).
      const merged = { ...JSON.parse(open.data), ...stored };
      db.prepare(`UPDATE local_changes SET data = ?, made_at = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), now, now, open.id);
      change.id = open.id;
    } else if (open && change.op === 'delete' && open.op === 'create') {
      // Created here and deleted before the cloud ever heard of it: nothing to send.
      db.prepare(`DELETE FROM local_changes WHERE id = ?`).run(open.id);
      change.id = '';
    } else {
      if (change.entity === 'staff_pin') db.prepare(`DELETE FROM local_changes WHERE entity = 'staff_pin' AND entity_id = ? AND state = 'pending'`).run(entityId);
      db.prepare(`INSERT INTO local_changes (id, entity, op, entity_id, base, data, made_by, made_by_name, made_at, state, tries, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`).run(change.id, change.entity, change.op, entityId,
        change.base ? JSON.stringify(change.base) : null, JSON.stringify(stored), maker.id, maker.name, now, now);
    }
    applyLocal(db, change, { pinHashEnc, roleName: local.roleName, permissions: local.permissions, branchId: local.branchId });
    bumpChangeVersion(db, now);
  })();
  return { ok: true, change };
}

/** A448: this machine's change counter — moves whenever a change is recorded or relayed here (a branch server's tills
 *  ask it when the cloud cannot be reached, and pull from the server when it moved). */
export function bumpChangeVersion(db: Database.Database, now = new Date().toISOString()): string {
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('local_change_version', ?, ?)`).run(now, now);
  return now;
}
export function changeVersion(db: Database.Database): string | null {
  try { return (db.prepare(`SELECT value FROM maintenance_state WHERE key = 'local_change_version'`).get() as { value?: string } | undefined)?.value ?? null; }
  catch { return null; }
}

/** Lay every change still waiting (not yet answered, or with the owner) back over what a pull just wrote. */
export function overlayLocalChanges(db: Database.Database): number {
  ensureTable(db);
  const rows = db.prepare(`SELECT * FROM local_changes WHERE state IN ('pending', 'awaiting') ORDER BY made_at`).all() as LocalChangeRow[];
  for (const r of rows) {
    const data = JSON.parse(r.data);
    try {
      applyLocal(db, { entity: r.entity, op: r.op as any, entity_id: r.canonical_id ?? r.entity_id, data },
        { pinHashEnc: data.pin_hash_enc ?? null, roleName: data.role_name, permissions: data.permissions, branchId: data.branch_id });
    } catch { /* a table not there yet — the next pull lays it again */ }
  }
  return rows.length;
}

/** The change as the branch server is handed it: the cloud's form, plus what only a till keeps (`_local`). */
export function relayChange(r: LocalChangeRow, secrets: Secrets): Record<string, unknown> {
  const data = JSON.parse(r.data);
  return { ...wireChange(r, secrets), _local: { role_name: data.role_name ?? null, permissions: data.permissions ?? null, branch_id: data.branch_id ?? null } };
}

/** The change as the cloud is sent it (the PIN unwrapped; what only this till needs left out). */
export function wireChange(r: LocalChangeRow, secrets: Secrets): Record<string, unknown> {
  const data = JSON.parse(r.data);
  if (data.pin) data.pin = secrets.unwrap(String(data.pin));
  delete data.pin_hash_enc; delete data.role_name; delete data.permissions; delete data.branch_id;
  return { id: r.id, entity: r.entity, op: r.op, entity_id: r.entity_id, base: r.base ? JSON.parse(r.base) : null, data,
    made_by: r.made_by, made_by_name: r.made_by_name, made_at: r.made_at };
}

/** A create the cloud already had under another id: this till takes the cloud's id everywhere it used its own. */
export function adoptCanonical(db: Database.Database, entity: ChangeEntity, from: string, to: string): void {
  if (from === to) return;
  db.transaction(() => {
    if (entity === 'station') {
      const has = db.prepare(`SELECT 1 FROM print_stations WHERE id = ?`).get(to);
      if (has) db.prepare(`DELETE FROM print_stations WHERE id = ?`).run(from); else db.prepare(`UPDATE print_stations SET id = ? WHERE id = ?`).run(to, from);
      db.prepare(`UPDATE OR IGNORE category_stations SET station_id = ? WHERE station_id = ?`).run(to, from);
      try { db.prepare(`UPDATE OR IGNORE station_printers SET station_id = ? WHERE station_id = ?`).run(to, from); } catch { /* no printers table */ }
    } else if (entity === 'category') {
      const has = db.prepare(`SELECT 1 FROM categories WHERE id = ?`).get(to);
      if (has) db.prepare(`DELETE FROM categories WHERE id = ?`).run(from); else db.prepare(`UPDATE categories SET id = ? WHERE id = ?`).run(to, from);
      db.prepare(`UPDATE products SET category_id = ? WHERE category_id = ?`).run(to, from);
      db.prepare(`UPDATE OR IGNORE category_stations SET category_id = ? WHERE category_id = ?`).run(to, from);
      // A product waiting to be sent that names the old id names the cloud's now.
      for (const r of db.prepare(`SELECT id, data FROM local_changes WHERE entity = 'product' AND state = 'pending'`).all() as Array<{ id: string; data: string }>) {
        const d = JSON.parse(r.data);
        if (d.category_id === from) { d.category_id = to; db.prepare(`UPDATE local_changes SET data = ? WHERE id = ?`).run(JSON.stringify(d), r.id); }
      }
    } else if (entity === 'product') {
      const has = db.prepare(`SELECT 1 FROM products WHERE id = ?`).get(to);
      if (has) db.prepare(`DELETE FROM products WHERE id = ?`).run(from); else db.prepare(`UPDATE products SET id = ? WHERE id = ?`).run(to, from);
    }
    db.prepare(`UPDATE local_changes SET entity_id = ? WHERE entity = ? AND entity_id = ? AND state = 'pending'`).run(to, entity, from);
  })();
}

/** A create the cloud refused for good: this till drops its own copy (the cloud never had it). */
function undoRefusedCreate(db: Database.Database, entity: ChangeEntity, id: string): void {
  if (entity === 'station') { db.prepare(`DELETE FROM category_stations WHERE station_id = ?`).run(id); db.prepare(`DELETE FROM print_stations WHERE id = ?`).run(id); }
  else if (entity === 'category') db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
  else if (entity === 'product') db.prepare(`DELETE FROM products WHERE id = ?`).run(id);
  else if (entity === 'staff') db.prepare(`DELETE FROM branch_staff WHERE staff_id = ?`).run(id);
}

export interface PushDeps {
  /** POST /api/changes with this till's own session (through its branch server on a till behind one). */
  post: (changes: Record<string, unknown>[]) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  /** GET /api/changes/state?ids= for changes with the owner. */
  state: (ids: string[]) => Promise<Array<{ id: string; status: string; message?: string | null }>>;
  secrets: Secrets;
  log?: (line: string) => void;
}

/** Send what waits; ask after what is with the owner. Returns whether anything settled (the caller then pulls). Never throws. */
export async function pushLocalChanges(db: Database.Database, d: PushDeps): Promise<{ sent: number; settled: number; error?: string }> {
  ensureTable(db);
  const now = () => new Date().toISOString();
  let settled = 0;
  const pending = db.prepare(`SELECT * FROM local_changes WHERE state = 'pending' ORDER BY made_at LIMIT 50`).all() as LocalChangeRow[];
  if (pending.length) {
    let res;
    try { res = await d.post(pending.map((r) => wireChange(r, d.secrets))); }
    catch (e: any) { return { sent: 0, settled: 0, error: e?.message ?? 'unreachable' }; }
    if (!res.ok) return { sent: 0, settled: 0, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    const up = db.prepare(`UPDATE local_changes SET state = ?, message = ?, canonical_id = ?, tries = tries + 1, updated_at = ? WHERE id = ?`);
    for (const r of (body?.results ?? []) as Array<{ id: string; status: string; message?: string; canonical_id?: string; retry?: boolean }>) {
      const row = pending.find((p) => p.id === r.id);
      if (!row) continue;
      if (r.status === 'applied' || r.status === 'identical') {
        if (r.canonical_id) adoptCanonical(db, row.entity, row.entity_id, r.canonical_id);
        up.run('done', null, r.canonical_id ?? null, now(), r.id); settled++;
        d.log?.(`${describeChange({ entity: row.entity, op: row.op as any, data: JSON.parse(row.data) })}: on the cloud (${r.status})`);
      } else if (r.status === 'awaiting') {
        up.run('awaiting', r.message ?? 'waiting for the owner', r.canonical_id ?? null, now(), r.id);
        d.log?.(`${describeChange({ entity: row.entity, op: row.op as any, data: JSON.parse(row.data) })}: waiting for the owner's approval`);
      } else if (r.status === 'refused' && r.retry) {
        db.prepare(`UPDATE local_changes SET message = ?, tries = tries + 1, updated_at = ? WHERE id = ?`).run(r.message ?? null, now(), r.id);
      } else {
        if (row.op === 'create') undoRefusedCreate(db, row.entity, row.entity_id);
        up.run('refused', r.message ?? 'refused', null, now(), r.id); settled++;
        d.log?.(`${describeChange({ entity: row.entity, op: row.op as any, data: JSON.parse(row.data) })}: refused — ${r.message ?? ''}`);
      }
    }
  }
  // With the owner: approved → done; rejected → this till drops its own and takes the cloud's on the next pull.
  const waiting = db.prepare(`SELECT id, entity, op, entity_id FROM local_changes WHERE state = 'awaiting' LIMIT 100`).all() as LocalChangeRow[];
  if (waiting.length) {
    try {
      for (const s of await d.state(waiting.map((w) => w.id))) {
        const row = waiting.find((w) => w.id === s.id);
        if (!row || !['approved', 'rejected'].includes(s.status)) continue;
        if (s.status === 'rejected' && row.op === 'create') undoRefusedCreate(db, row.entity, row.entity_id);
        db.prepare(`UPDATE local_changes SET state = ?, message = ?, updated_at = ? WHERE id = ?`)
          .run(s.status === 'approved' ? 'done' : 'rejected', s.status === 'approved' ? null : 'the owner kept the cloud\'s', now(), s.id);
        settled++;
      }
    } catch { /* asked again on the next beat */ }
  }
  // Old settled rows go after a week.
  db.prepare(`DELETE FROM local_changes WHERE state IN ('done', 'rejected', 'refused') AND updated_at < ?`).run(new Date(Date.now() - 7 * 86400_000).toISOString());
  return { sent: pending.length, settled };
}

/** What waits, for the screens ("not on the cloud yet" / "waiting for the owner" / "refused: …"). */
export function changeStates(db: Database.Database, entity?: ChangeEntity): Array<{ entity_id: string; entity: ChangeEntity; state: LocalState; message: string | null; summary: string }> {
  ensureTable(db);
  const rows = db.prepare(`SELECT * FROM local_changes WHERE state IN ('pending', 'awaiting', 'refused') ${entity ? 'AND entity = ?' : ''} ORDER BY made_at DESC LIMIT 200`)
    .all(...(entity ? [entity] : [])) as LocalChangeRow[];
  return rows.map((r) => ({ entity_id: r.canonical_id ?? r.entity_id, entity: r.entity, state: r.state, message: r.message,
    summary: describeChange({ entity: r.entity, op: r.op as any, data: JSON.parse(r.data) }) }));
}

/** Changes a till behind this branch server handed it: applied here and queued here too (the cloud dedupes by id). */
export function acceptRelayedChanges(db: Database.Database, raws: unknown[], secrets: Secrets): number {
  ensureTable(db);
  let n = 0;
  for (const raw of raws) {
    const c = cleanChange(raw);
    if (!c.ok) continue;
    const ch = (c as { change: TillChange }).change;
    if (db.prepare(`SELECT 1 FROM local_changes WHERE id = ?`).get(ch.id)) continue;
    let pinHashEnc: string | null = null;
    const stored: Record<string, unknown> = { ...ch.data };
    // What only a till keeps (a new cashier's role and permissions, the branch), handed over with the change.
    const extra = (raw as any)?._local ?? {};
    if (ch.entity === 'staff' || ch.entity === 'staff_pin') {
      pinHashEnc = secrets.seal(bcrypt.hashSync(String(ch.data.pin), 10));
      stored.pin = secrets.wrap(String(ch.data.pin)); stored.pin_hash_enc = pinHashEnc;
      stored.role_name = extra.role_name ?? null; stored.permissions = extra.permissions ?? null; stored.branch_id = extra.branch_id ?? null;
    }
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`INSERT INTO local_changes (id, entity, op, entity_id, base, data, made_by, made_by_name, made_at, state, tries, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`).run(ch.id, ch.entity, ch.op, ch.entity_id,
        ch.base ? JSON.stringify(ch.base) : null, JSON.stringify(stored), ch.made_by, ch.made_by_name, ch.made_at, now);
      applyLocal(db, ch, { pinHashEnc, roleName: extra.role_name ?? null, permissions: extra.permissions, branchId: extra.branch_id ?? null });
      bumpChangeVersion(db, now);
    })();
    n++;
  }
  return n;
}

export { ENTITY_SPECS };
