/**
 * choiceGroups.ts — A591: a till's whole-menu pull asks for each product's variants and modifiers one product at a time.
 *
 * Owner's System page, 2026-10-26: /api/variants 100 requests in 10 minutes. A till before 1.0.20 takes the whole menu
 * every 10 minutes, and that pull asks GET /api/variants/groups?product_id= (and /api/modifiers/groups) once for EVERY
 * product with options — two Supabase calls each (the product's business check, then its groups). Every call is a line in
 * Supabase's logs (0.8 of the Free plan's 1 GB this cycle) and its egress.
 *
 * For a TILL's ask (the pull), the first product's ask reads the business's product ids and ALL its groups with their
 * options in a few calls (150 products a call), and the rest of the pull is answered from memory: the same rows
 * (`*, <options>(*)`, by sort_order), the same 404 for a product not of this business. Kept while nothing has been written
 * for the business through this server (lib/writeActivity.ts) and at most 10 minutes (the old pull's own cadence). The
 * web dashboard's ask (one product, while editing it) reads as before. A591_MEMO=off: every ask reads as before.
 */
import { supabase } from './supabase';
import { pageAll, SAFE_CHUNK } from './pgQuery';
import { memoEnabled, catalogueGen } from './writeActivity';
import { traffic } from './trafficStats';

export type ChoiceKind = 'variant' | 'modifier';
export const CHOICE_MAX_AGE_MS = 10 * 60_000;
/**
 * A593: a POS before 1.0.20 pulls every 10 minutes, so a 10-minute memory was rebuilt on almost every pull. Kept up to an
 * hour while no catalogue write was made for the business (the same rule as /init, lib/posInit.ts) — every variant or
 * modifier edit comes through a catalogue router and moves the generation at once; a change straight in SQL: an hour.
 */
export const CHOICE_QUIET_AGE_MS = 60 * 60_000;
const ROW_CAP = 1000;   // a chunk answered with this many rows may have been cut short (db-max-rows): not kept
const MAX_BUSINESSES = 500;

/** The same reads as routes/variants.ts and routes/modifiers.ts GET /groups, for many products at once. */
const groupsOf = (kind: ChoiceKind, productIds: string[]) => (kind === 'variant'
  ? supabase.from('variant_groups').select('*, variant_options(*)').in('product_id', productIds).order('sort_order')
  : supabase.from('modifier_groups').select('*, modifier_options(*)').in('product_id', productIds).order('sort_order'));

interface Kept { gen: string; at: number; products: Set<string>; byProduct: Map<string, any[]> }
const kept = new Map<string, Kept>();
const building = new Map<string, Promise<Kept | null>>();
let clock: () => number = () => Date.now();

async function build(kind: ChoiceKind, businessId: string): Promise<Kept | null> {
  const gen = catalogueGen(businessId);   // before the reads: a write meanwhile makes the next ask read again
  const at = clock();
  const ids = (await pageAll<{ id: string }>(() => supabase.from('products').select('id').eq('business_id', businessId), 1000))
    .map((r) => String(r.id));
  const byProduct = new Map<string, any[]>();
  for (let i = 0; i < ids.length; i += SAFE_CHUNK) {
    const chunk = ids.slice(i, i + SAFE_CHUNK);
    const { data, error } = await groupsOf(kind, chunk);
    if (error) throw error;
    const rows = (data ?? []) as any[];
    if (rows.length >= ROW_CAP) return null;   // possibly cut short: not kept, the ask reads as before
    for (const g of rows) {
      const k = String(g.product_id);
      const list = byProduct.get(k) ?? [];
      list.push(g); byProduct.set(k, list);
    }
  }
  return { gen, at, products: new Set(ids), byProduct };
}

/**
 * A till's ask: `{ found, groups }` from memory (built on the first ask), or null when it cannot be answered from memory
 * (off, cut short) — the route then reads as before. Throws on a database error (the route answers it as before).
 */
export async function tillChoiceGroups(kind: ChoiceKind, businessId: string, productId: string): Promise<{ found: boolean; groups: any[] } | null> {
  if (!memoEnabled()) return null;
  const key = `${kind}|${businessId}`;
  let k = kept.get(key);
  const now = clock();
  if (!k || k.gen !== catalogueGen(businessId) || now - k.at >= CHOICE_QUIET_AGE_MS) {   // A593: an hour (10 min before)
    let p = building.get(key);
    if (!p) {
      p = build(kind, businessId);
      building.set(key, p);
      p.finally(() => { if (building.get(key) === p) building.delete(key); }).catch(() => { /* the caller sees it */ });
    }
    const built = await p;
    if (!built) { traffic.count(`${kind}s.cut_short`); return null; }
    k = built;
    kept.delete(key); kept.set(key, k);
    while (kept.size > MAX_BUSINESSES) { const first = kept.keys().next().value; if (first === undefined) break; kept.delete(first); }
    traffic.count(`${kind}s.built`);
  } else traffic.count(`${kind}s.from_memory`);
  if (!k.products.has(productId)) return { found: false, groups: [] };
  return { found: true, groups: k.byProduct.get(productId) ?? [] };
}

/** Test seams. */
export function _resetChoiceGroups(): void { kept.clear(); building.clear(); }
export function _setChoiceClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
