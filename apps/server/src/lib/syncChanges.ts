/**
 * syncChanges.ts — A531: GET /api/pos/changes — the rows that changed since a till last applied, and nothing else.
 *
 * Owner, 2026-10-19: "if I change fries from 100 to 150 the trigger should only send the affected product and price, not
 * the whole menu (70 products → 69 needless); if Eugene's PIN changes only Eugene's change gets synced, not all 150
 * staff." The database writes one entry per changed row (migration 151, public.sync_changes); this reads the entries after
 * the till's last applied number (`since`) and answers each with the row ITSELF, in the shape the till already stores
 * from /api/pos/init (or a delete marker):
 *
 *   products         { product (init's row: category name/colour, this branch's price), comboItems (a combo's lines) }
 *   product_choices  { product_id, variantGroups, modifierGroups } — as /api/variants/groups and /api/modifiers/groups
 *   categories       the category row
 *   menus            A537: the menu row (id, name, sort_order, active, color, icon) — a delete when off or deleted
 *   offers / promotions  the offer row pos/init sends (a promotion as the offer it is charged as)
 *   stock_count      { stockCount } — this branch's freeze
 *   staff            { user: { id, name, roles: { name }, status }, roster } — the roster row exactly as branch-staff
 *                    sends it (bcrypt PIN hash, the permission map; override PIN never), and only to a till's own session
 *   config           money / look / setup: that topic's pos/init keys (shared/syncTopics.ts CONFIG_KEYS)
 *   branding         { branding, themeId }
 *   print_stations   { stations } — the whole list with category_ids, as /api/stations (a few rows)
 *   tables / pumps   the row, at this branch (pumps: or every branch)
 *   stock            A535 (migration 153): { product_id, branch_id, quantity, low_stock_threshold, qty_pieces } — the level
 *                    at THIS branch as /api/inventory?branch_id= sends it; a level hidden by a blind count (A394) is sent as
 *                    { counting: true } without its figures (the till keeps what it has); a level gone is a delete
 *
 * The same row changed several times is answered once (its newest entry). Another branch's rows never reach a till
 * (the entry's branch, and each row's own branch). Nothing of another business (every read is by the caller's business).
 * Per caller: the roster's PIN hashes (a till's own session only) and the cost prices (removed, as /init does) — the
 * answer is remembered 5 s per (business, branch, since, those two), so the tills of a business that all heard the same
 * push share one build. Paged: at most 500 entries; `more` = ask again from `last_seq`. A till whose `since` is older
 * than the oldest entry kept (30 days, prune_sync_changes) is told `full_resync_needed`.
 */
import { supabase } from './supabase';
import { traffic } from './trafficStats';
import { CONFIG_KEYS, CHANGE_TABLES, isSyncTopic, type ChangeEntry, type ChangesAnswer, type ChangeTable, type SyncTopicName } from './syncTopics';
import { initAnswer } from './posInit';
import { readTopicVersion } from './syncVersions';
import { stripFields, COST_FIELDS } from './costAccess';
import { worksAtBranch } from './branchAccess';
import { effectiveKeysForRow, clientPermissionMap } from './effectivePermissions';
import { promotionAsOfferRow, type PromotionRow } from './promotionOffers';
import { frozenAtBranch, openTake } from './stockTakeAccess';
import { chunkPaged } from './pgQuery';

export const CHANGES_PAGE = 500;
const ANSWER_TTL_MS = 5_000;
const FLOOR_TTL_MS = 10 * 60_000;
const BRANCHES_TTL_MS = 60_000;

export interface ChangesCaller {
  businessId: string;
  /** The branch the till sent (?branch_id); validated to the business, else the main branch. */
  branchId: string | null;
  /** A till's own session: the roster rows (PIN hashes) are for it alone. */
  isTill: boolean;
  /** May see cost prices (a person with menu.costs / reports.costs); a till never does. */
  seesCosts: boolean;
  /** A535: may see a level a blind count is counting (inventory.adjust — a till's own session never: A394 / A494). */
  seesCountedStock?: boolean;
}

/**
 * The change log could not be read. `missing` = it is not there (migration 151 not run): the route answers 404 and the
 * till keeps its old way (a signed 404 is this cloud saying "no such thing" — A529); otherwise 503 (asked again later).
 */
export class ChangesUnavailable extends Error {
  missing: boolean;
  constructor(e: { message?: string; code?: string } | string) {
    const m = typeof e === 'string' ? e : String(e?.message ?? 'unavailable');
    super(m); this.name = 'ChangesUnavailable';
    const code = typeof e === 'string' ? '' : String(e?.code ?? '');
    this.missing = ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(code) || /does not exist|could not find the (function|table)/i.test(m);
  }
}

interface RawEntry { seq: number; topic: string; table_name: string; row_id: string; op: string; changed_at: string | null }

// ── small caches ───────────────────────────────────────────────────────────────────────────────────────────────────
let floor: { value: number; at: number } | null = null;
let stockReady: { value: boolean; at: number } | null = null;
const STOCK_READY_TTL_MS = 10 * 60_000;
const branchesOf = new Map<string, { at: number; rows: Array<{ id: string; is_main?: boolean }> }>();
const answers = new Map<string, { at: number; value: ChangesAnswer }>();

/** Test seam. */
export function _resetSyncChanges(): void { floor = null; stockReady = null; branchesOf.clear(); answers.clear(); }

/**
 * A535: does this database log stock levels (migration 153)? Asked once per 10 minutes (sync_stock_ready). Only then is a
 * till told `serves: ['stock']` and drops its 30-minute stock re-read — before 153 it keeps re-reading.
 */
export async function servesStock(now = Date.now()): Promise<boolean> {
  if (stockReady && now - stockReady.at < STOCK_READY_TTL_MS) return stockReady.value;
  let value = false;
  try { const { data, error } = await supabase.rpc('sync_stock_ready'); value = !error && data === true; } catch { value = false; }
  stockReady = { value, at: now };
  return value;
}
/** A change this server just made: the remembered answers of the business go (the push follows at once). */
export function forgetChangesOf(businessId: string | null): void {
  if (!businessId) { answers.clear(); return; }
  for (const k of [...answers.keys()]) if (k.startsWith(`${businessId}|`)) answers.delete(k);
}

async function changeFloor(now: number): Promise<number> {
  if (floor && now - floor.at < FLOOR_TTL_MS) return floor.value;
  const { data, error } = await supabase.from('sync_change_floor').select('floor_seq').eq('id', 1).maybeSingle();
  if (error) throw new ChangesUnavailable(error);
  const value = Number((data as { floor_seq?: number | string } | null)?.floor_seq ?? 0) || 0;
  floor = { value, at: now };
  return value;
}

/** The newest entry of the business (0 = none yet). */
export async function latestSeq(businessId: string): Promise<number> {
  traffic.queries(1);
  const { data, error } = await supabase.from('sync_changes').select('seq').eq('business_id', businessId)
    .order('seq', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ChangesUnavailable(error);
  return Number((data as { seq?: number | string } | null)?.seq ?? 0) || 0;
}

/** The till's operating branch: the one it sent when it is this business's, else the main branch (as /init — D11). */
async function operatingBranch(businessId: string, requested: string | null, now: number): Promise<string | null> {
  let hit = branchesOf.get(businessId);
  if (!hit || now - hit.at >= BRANCHES_TTL_MS) {
    const { data } = await supabase.from('branches').select('id, is_main').eq('business_id', businessId);
    hit = { at: now, rows: (data ?? []) as Array<{ id: string; is_main?: boolean }> };
    branchesOf.set(businessId, hit);
    while (branchesOf.size > 5_000) { const k = branchesOf.keys().next().value; if (k === undefined) break; branchesOf.delete(k); }
  }
  if (requested && hit.rows.some((b) => b.id === requested)) return requested;
  return hit.rows.find((b) => b.is_main)?.id ?? null;
}

/** GET /api/pos/changes. `since` null = "where is the log now" (a till about to take the whole menu notes it first). */
export async function changesAnswer(c: ChangesCaller, since: number | null, now = Date.now()): Promise<ChangesAnswer> {
  const serves = (await servesStock(now)) ? { serves: ['stock'] } : {};   // A535
  if (since === null || !Number.isFinite(since) || since < 0) {
    return { last_seq: await latestSeq(c.businessId), changes: [], ...serves };
  }
  const branch = await operatingBranch(c.businessId, c.branchId, now);
  const key = `${c.businessId}|${branch ?? ''}|${since}|${c.isTill ? 1 : 0}|${c.seesCosts ? 1 : 0}|${c.seesCountedStock ? 1 : 0}`;
  const hit = answers.get(key);
  if (hit && now - hit.at < ANSWER_TTL_MS) { traffic.count('changes.from_memory'); return hit.value; }

  if (since < await changeFloor(now)) {
    traffic.count('changes.full_resync');
    return { last_seq: await latestSeq(c.businessId), changes: [], full_resync_needed: true, ...serves };
  }
  traffic.count('changes.read'); traffic.queries(1);
  const { data, error } = await supabase.rpc('sync_changes_since', { p_business: c.businessId, p_since: since, p_branch: branch, p_limit: CHANGES_PAGE + 1 });
  if (error) throw new ChangesUnavailable(error);
  let raw = ((data ?? []) as RawEntry[]).map((r) => ({ ...r, seq: Number(r.seq) }));
  const more = raw.length > CHANGES_PAGE;
  if (more) raw = raw.slice(0, CHANGES_PAGE);
  const last_seq = raw.reduce((m, r) => Math.max(m, r.seq), since);

  // The same row once: its newest entry.
  const newest = new Map<string, RawEntry>();
  for (const r of raw) {
    if (!(r.table_name in CHANGE_TABLES)) continue;   // a table a newer database writes and this server does not know
    const k = `${r.table_name}|${r.row_id}`;
    const had = newest.get(k);
    if (!had || had.seq < r.seq) newest.set(k, r);
  }
  const changes = await rowsFor(c, branch, [...newest.values()], now);
  const value: ChangesAnswer = { last_seq, changes: changes.sort((a, b) => a.seq - b.seq), ...(more ? { more: true } : {}), ...serves };
  answers.set(key, { at: now, value });
  while (answers.size > 2_000) { const k = answers.keys().next().value; if (k === undefined) break; answers.delete(k); }
  return value;
}

// ── each logical table's rows ──────────────────────────────────────────────────────────────────────────────────────
type Built = ChangeEntry;
const entry = (e: RawEntry, table: ChangeTable, id: string, op: 'upsert' | 'delete', row?: unknown): Built =>
  ({ seq: e.seq, topic: (isSyncTopic(e.topic) ? e.topic : 'setup') as SyncTopicName, table, id, op, ...(op === 'upsert' ? { row } : {}) });

async function inChunks<T>(ids: string[], read: (chunk: string[]) => any): Promise<T[]> {
  if (!ids.length) return [];
  return chunkPaged<T>(ids, read);
}

async function rowsFor(c: ChangesCaller, branch: string | null, entries: RawEntry[], now: number): Promise<Built[]> {
  const by = (t: string) => entries.filter((e) => e.table_name === t);
  const out: Built[] = [];
  const biz = c.businessId;
  const noCosts = c.isTill || !c.seesCosts;
  const clean = <T>(v: T): T => (noCosts ? stripFields(v, new Set(COST_FIELDS)) : v);

  // products (+ the combos a changed product is a line of: their lines carry its name and kitchen routing)
  const prodEntries = by('products');
  if (prodEntries.length) {
    const ids = [...new Set(prodEntries.map((e) => e.row_id))];
    const lines = await inChunks<{ combo_id: string }>(ids, (chunk) => supabase.from('combo_items').select('combo_id').in('product_id', chunk));
    const extraCombos = [...new Set(lines.map((l) => l.combo_id))].filter((x) => x && !ids.includes(x));
    const all = [...ids, ...extraCombos];
    const rows = await inChunks<any>(all, (chunk) => supabase.from('products').select('*, categories(name, color)').eq('business_id', biz).in('id', chunk));
    const comboIds = rows.filter((p) => p.is_combo).map((p) => p.id);
    const comboRows = await inChunks<any>(comboIds, (chunk) => supabase.from('products')
      .select('id, combo_items!combo_id ( quantity, sort_order, product:product_id ( id, name, is_kitchen, category_id, categories ( is_kitchen ) ) )')
      .eq('business_id', biz).in('id', chunk));
    const prices = branch ? await inChunks<{ product_id: string; price: number }>(all, (chunk) => supabase.from('branch_prices')
      .select('id, product_id, price').eq('branch_id', branch).in('product_id', chunk)) : [];
    const priceOf = new Map(prices.map((p) => [p.product_id, p.price]));
    const lineOf = comboLines(comboRows);
    const byId = new Map(rows.map((p) => [String(p.id), p]));
    const pseudo = (id: string): RawEntry => prodEntries.find((e) => e.row_id === id) ?? { ...prodEntries[prodEntries.length - 1], row_id: id };
    for (const id of all) {
      const e = pseudo(id);
      const p = byId.get(id);
      if (!p || p.status !== 'active') { out.push(entry(e, 'products', id, 'delete')); continue; }
      out.push(entry(e, 'products', id, 'upsert', clean({ product: { ...p, branch_price: priceOf.get(id) ?? null }, comboItems: p.is_combo ? (lineOf[id] ?? []) : null })));
    }
  }

  // product_choices
  const choiceEntries = by('product_choices');
  if (choiceEntries.length) {
    const ids = [...new Set(choiceEntries.map((e) => e.row_id))];
    const mine = new Set((await inChunks<{ id: string }>(ids, (chunk) => supabase.from('products').select('id').eq('business_id', biz).in('id', chunk))).map((p) => String(p.id)));
    const owned = ids.filter((id) => mine.has(id));
    const vg = await inChunks<any>(owned, (chunk) => supabase.from('variant_groups').select('*, variant_options(*)').in('product_id', chunk));
    const mg = await inChunks<any>(owned, (chunk) => supabase.from('modifier_groups').select('*, modifier_options(*)').in('product_id', chunk));
    const sort = (a: any, b: any) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    for (const e of choiceEntries) {
      if (!mine.has(e.row_id)) { out.push(entry(e, 'product_choices', e.row_id, 'delete')); continue; }
      out.push(entry(e, 'product_choices', e.row_id, 'upsert', clean({
        product_id: e.row_id,
        variantGroups: vg.filter((g) => String(g.product_id) === e.row_id).sort(sort),
        modifierGroups: mg.filter((g) => String(g.product_id) === e.row_id).sort(sort),
      })));
    }
  }

  // categories
  const catEntries = by('categories');
  if (catEntries.length) {
    const rows = await inChunks<any>(catEntries.map((e) => e.row_id), (chunk) => supabase.from('categories').select('*').eq('business_id', biz).in('id', chunk));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const e of catEntries) {
      const r = byId.get(e.row_id);
      out.push(r && r.status === 'active' ? entry(e, 'categories', e.row_id, 'upsert', r) : entry(e, 'categories', e.row_id, 'delete'));
    }
  }

  // A537: menus — the row as /init sends it (on, not deleted), else a delete (switched off, deleted, or not this business's)
  const menuEntries = by('menus');
  if (menuEntries.length) {
    const rows = await inChunks<any>(menuEntries.map((e) => e.row_id), (chunk) => supabase.from('menus').select('id, name, sort_order, active, color, icon, deleted_at').eq('business_id', biz).in('id', chunk));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const e of menuEntries) {
      const r = byId.get(e.row_id);
      if (r && r.active === true && !r.deleted_at) {
        out.push(entry(e, 'menus', e.row_id, 'upsert', { id: r.id, name: r.name, sort_order: r.sort_order, active: true, color: r.color ?? null, icon: r.icon ?? null }));
      } else out.push(entry(e, 'menus', e.row_id, 'delete'));
    }
  }

  // offers: on, not deleted, for every branch or this one (as offersForBranch)
  const offerEntries = by('offers');
  if (offerEntries.length) {
    const rows = await inChunks<any>(offerEntries.map((e) => e.row_id), (chunk) => supabase.from('offers').select('*').eq('business_id', biz).in('id', chunk));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const e of offerEntries) {
      const r = byId.get(e.row_id);
      const runs = r && r.active === true && !r.deleted_at && (!r.branch_ids || (branch && (r.branch_ids as string[]).includes(branch)));
      out.push(runs ? entry(e, 'offers', e.row_id, 'upsert', r) : entry(e, 'offers', e.row_id, 'delete'));
    }
  }
  // promotions: the offer each is charged as (A518), or none
  const promoEntries = by('promotions');
  if (promoEntries.length) {
    const rows = await inChunks<PromotionRow>(promoEntries.map((e) => e.row_id), (chunk) => supabase.from('promotions').select('*').eq('business_id', biz).in('id', chunk));
    const byId = new Map(rows.map((r) => [String((r as any).id), r]));
    for (const e of promoEntries) {
      const r = byId.get(e.row_id);
      const asOffer = r ? promotionAsOfferRow(r) : null;
      out.push(asOffer ? entry(e, 'offers', e.row_id, 'upsert', asOffer) : entry(e, 'offers', e.row_id, 'delete'));
    }
  }

  // stock_count: this branch's freeze (one row, whichever entry named it)
  const stockEntries = by('stock_count');
  if (stockEntries.length) {
    const e = stockEntries.reduce((a, b) => (a.seq > b.seq ? a : b));
    out.push(entry(e, 'stock_count', 'stock_count', 'upsert', { stockCount: await frozenAtBranch(biz, branch) }));
  }

  // staff (+ everyone holding a changed role)
  const staffEntries = by('staff');
  const roleEntries = by('roles');
  if (staffEntries.length || roleEntries.length) {
    const ids = new Set(staffEntries.map((e) => e.row_id));
    const viaRole = new Map<string, RawEntry>();
    if (roleEntries.length) {
      const holders = await inChunks<{ id: string; role_id: string }>(roleEntries.map((e) => e.row_id), (chunk) => supabase.from('users')
        .select('id, role_id').eq('business_id', biz).in('role_id', chunk));
      for (const h of holders) {
        const e = roleEntries.find((r) => r.row_id === String(h.role_id))!;
        if (!ids.has(String(h.id))) viaRole.set(String(h.id), e);
        ids.add(String(h.id));
      }
    }
    const rows = await inChunks<any>([...ids], (chunk) => supabase.from('users').select(`
      id, name, status, pin_hash,
      roles ( name, role_permissions ( permissions ( key ) ) ),
      user_branches ( branch_id ),
      user_permissions ( granted, permissions ( key ) )
    `).eq('business_id', biz).in('id', chunk));
    const byId = new Map(rows.map((u) => [String(u.id), u]));
    for (const id of ids) {
      const e = staffEntries.find((s) => s.row_id === id) ?? viaRole.get(id)!;
      const u = byId.get(id);
      if (!u) { out.push(entry(e, 'staff', id, 'delete')); continue; }
      out.push(entry(e, 'staff', id, 'upsert', {
        user: { id: u.id, name: u.name, roles: { name: u.roles?.name ?? null }, status: u.status ?? 'active' },
        // The roster row exactly as GET /api/pos/branch-staff makes it (A426 branch rule, A490 permission map, bcrypt only,
        // A494 no override PIN) — null = not on this branch's list (inactive, another branch, no usable PIN). A till only.
        ...(c.isTill && branch ? { roster: rosterRow(u, branch) } : {}),
      }));
    }
  }

  // config / branding: from /init's kept answer, built after the change (lib/posInit.ts)
  const cfgEntries = [...by('config'), ...by('branding')];
  if (cfgEntries.length) {
    const changedAt = Math.max(...cfgEntries.map((e) => (e.changed_at ? Date.parse(e.changed_at) : now)));
    const version = await readTopicVersion(biz, 'catalogue');
    // 3 s: this server's clock and the database's are not the same clock.
    const built = await initAnswer(biz, c.branchId, version && version > 0 ? version : null, { now, notBefore: (Number.isFinite(changedAt) ? changedAt : now) + 3_000 });
    if (!built.ok) throw new Error((built as { error: { message: string } }).error?.message ?? 'init failed');
    const body = (built as { body: Record<string, unknown> }).body;
    for (const e of cfgEntries) {
      if (e.table_name === 'branding') {
        out.push(entry(e, 'branding', 'branding', 'upsert', { branding: body.branding ?? null, themeId: body.themeId ?? null }));
        continue;
      }
      const topic = e.row_id as keyof typeof CONFIG_KEYS;
      if (!(topic in CONFIG_KEYS)) continue;
      const row: Record<string, unknown> = {};
      for (const k of CONFIG_KEYS[topic]) if (k in body) row[k] = body[k];
      out.push(entry(e, 'config', topic, 'upsert', row));
    }
  }

  // print_stations: the whole (short) list, as /api/stations
  const stationEntries = by('print_stations');
  if (stationEntries.length) {
    const e = stationEntries.reduce((a, b) => (a.seq > b.seq ? a : b));
    const { data: stations } = await supabase.from('print_stations').select('*').eq('business_id', biz).order('sort_order');
    const ids = ((stations ?? []) as Array<{ id: string }>).map((s) => s.id);
    // category_stations has no id column to page by: one read (a business has a few stations).
    const { data: linkRows } = ids.length
      ? await supabase.from('category_stations').select('category_id, station_id').in('station_id', ids)
      : { data: [] as Array<{ category_id: string; station_id: string }> };
    const links = (linkRows ?? []) as Array<{ category_id: string; station_id: string }>;
    out.push(entry(e, 'print_stations', '*', 'upsert', {
      stations: ((stations ?? []) as Array<{ id: string }>).map((s) => ({ ...s, category_ids: links.filter((l) => l.station_id === s.id).map((l) => l.category_id) })),
    }));
  }

  // tables (this branch, active) and pumps (this branch or every branch)
  for (const t of ['tables', 'pumps'] as const) {
    const es = by(t);
    if (!es.length) continue;
    const ids = es.map((e) => e.row_id);
    const rows = t === 'tables'
      ? await inChunks<any>(ids, (chunk) => supabase.from('tables').select('*').eq('business_id', biz).in('id', chunk))
      : await inChunks<any>(ids, (chunk) => supabase.from('pumps').select('*').eq('business_id', biz).in('id', chunk));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const e of es) {
      const r = byId.get(e.row_id);
      const here = r && (t === 'pumps' ? (!r.branch_id || r.branch_id === branch) : (r.branch_id === branch && (r.status ?? 'active') === 'active'));
      out.push(here ? entry(e, t, e.row_id, 'upsert', r) : entry(e, t, e.row_id, 'delete'));
    }
  }

  // A535: stock levels at THIS branch (the entry's branch is this one — sync_changes_since — and the row's own is read
  // here). The product must be this business's. A blind count hides a counted level's figures from a caller that may not
  // change stock (A394 — a till's own session): { counting: true }, the till keeps what it has.
  const stockLevelEntries = by('stock');
  if (stockLevelEntries.length && branch) {
    const ids = [...new Set(stockLevelEntries.map((e) => e.row_id))];
    const mine = new Set((await inChunks<{ id: string }>(ids, (chunk) => supabase.from('products').select('id').eq('business_id', biz).in('id', chunk)))
      .map((p) => String(p.id)));
    const owned = ids.filter((id) => mine.has(id));
    const rows = await inChunks<any>(owned, (chunk) => supabase.from('stock_levels')
      .select('id, product_id, branch_id, quantity, low_stock_threshold, qty_pieces').eq('branch_id', branch).in('product_id', chunk));
    const byId = new Map(rows.filter((r) => mine.has(String(r.product_id))).map((r) => [String(r.product_id), r]));
    let hidden = new Set<string>();
    if (!c.seesCountedStock) hidden = await countedAtBranch(biz, branch);
    for (const e of stockLevelEntries) {
      const r = byId.get(e.row_id);
      if (!r) { out.push(entry(e, 'stock', e.row_id, 'delete')); continue; }
      const level = { product_id: String(r.product_id), branch_id: String(r.branch_id), quantity: Number(r.quantity),
        low_stock_threshold: Number(r.low_stock_threshold), qty_pieces: Number(r.qty_pieces ?? 0) };
      out.push(entry(e, 'stock', e.row_id, 'upsert', hidden.has(e.row_id)
        ? { product_id: level.product_id, branch_id: level.branch_id, counting: true } : level));
    }
  }
  return out;
}

/** A535: the products a count at the branch is counting (A394's blind rule, as hiddenWhileCounting). Never throws. */
async function countedAtBranch(businessId: string, branchId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const take = await openTake(businessId, branchId);
    if (!take) return out;
    const { data } = await supabase.from('stock_take_lines').select('product_id').eq('stock_take_id', take.id).not('product_id', 'is', null).limit(5000);
    for (const l of (data ?? []) as Array<{ product_id: string | null }>) if (l.product_id) out.add(String(l.product_id));
  } catch { /* nothing hidden */ }
  return out;
}

/** A person's row on the branch's staff list — the same rule as GET /api/pos/branch-staff (routes/pos.ts). */
function rosterRow(u: any, branchId: string): Record<string, unknown> | null {
  if (u.status !== 'active') return null;
  if (!worksAtBranch(u.user_branches, branchId)) return null;
  if (!u.pin_hash || !String(u.pin_hash).startsWith('$2')) return null;
  return {
    staff_id: u.id, name: u.name, role_name: u.roles?.name ?? null, branch_id: branchId,
    permissions: clientPermissionMap(effectiveKeysForRow(u)),
    pin_hash: u.pin_hash ?? null, override_pin_hash: null, status: u.status,
  };
}

/** combo_id → its lines, as /init flattens them (routes/pos.ts buildInit). */
function comboLines(comboRows: any[]): Record<string, Array<{ product_id: string; name: string; quantity: number; is_kitchen: boolean; category_id: string | null }>> {
  const out: Record<string, Array<{ product_id: string; name: string; quantity: number; is_kitchen: boolean; category_id: string | null }>> = {};
  for (const c of comboRows) {
    out[c.id] = (c.combo_items ?? []).slice()
      .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((ci: any) => ({
        product_id: ci.product?.id ?? '', name: ci.product?.name ?? '', quantity: Number(ci.quantity ?? 1),
        is_kitchen: typeof ci.product?.is_kitchen === 'boolean' ? ci.product.is_kitchen : !!ci.product?.categories?.is_kitchen,
        category_id: ci.product?.category_id ?? null,
      }))
      .filter((i: any) => i.product_id);
  }
  return out;
}
