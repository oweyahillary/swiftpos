/**
 * analytics.ts — A549: Analytics v1 (premium), /api/analytics/*. The owner (and a manager in the manager portal) reads
 * menu engineering, a sales heatmap, money leaks, credit ageing and a short list of rule-based insights for a period.
 *
 * Gates, in order (every route):
 *   - signed in on the web (requireWebSurface), holding reports.sales — the sales report key (A490);
 *   - the business's 'analytics' flag (premium, set in the admin portal) — off: 403 { code: 'ANALYTICS_OFF' }, the same
 *     shape as THEMES_OFF;
 *   - the period: from / to (YYYY-MM-DD business dates, default the last 30 days), at most 366 days — 400 RANGE_TOO_LONG;
 *   - the branch: the owner sees every branch or one of THEIRS (?branch=, else the dashboard's X-Branch-Id; another
 *     business's branch is 404); anyone else sees their own branch only (another branch named: 403 BRANCH_SCOPE).
 * Everything is scoped by req.businessId.
 *
 * Cheap by design (the Render / Supabase quotas, A528 / A531): each figure is ONE aggregate function of migration 158
 * (a few hundred grouped rows, never a period of raw orders); each answer is kept 5 minutes per business, branch and
 * period (a request already in flight is shared, not repeated); the page never polls.
 * A553 (Analytics v2): GET /overview — the KPI row, the revenue trend against the PREVIOUS period of the same length and
 * the payment mix — from migration 160's analytics_daily_sales (both periods in ONE call) plus the money-leaks and menu
 * answers of each period (the current ones shared with the tabs through the cache). Costs, margins and the wastage
 * value go only to a caller who may see costs (A490 seesCosts); credit ageing needs customers.view or customers.credit.
 * A558 (decisions made easy): GET /item-times — what sells when (each product by business weekday × hour, migration 161's
 * analytics_item_times, ONE call) — and GET /recommendations — the "Do this next" cards and the "How was this period?"
 * summary, from the answers above (all shared through the cache: after /overview and /item-times it runs nothing new).
 * A560 (what to stock, never a price rise): /item-times adds `week` (each weekday's top 3 and their typical sales);
 * /recommendations reads the branch's stock levels now (stock_levels, tracked products of the 100 sent, none with a
 * recipe — three plain reads, kept 5 minutes) for "running low"; with every branch in view and more than one branch,
 * no stock level is read (stock is per branch) and `stockNote` says so.
 * A561: GET /stock (how fast stock goes — migration 162's analytics_stock_use; days left only for one branch), GET
 * /customers (who comes back and the order-type mix — analytics_customers; the customers themselves only with
 * customers.view or customers.credit, the mix for anyone with reports.sales) and GET /costs (food cost, the thinnest
 * margins, ingredient cost rises and the items with no cost — analytics_cost_watch plus the menu; seesCosts only, else
 * 403 COSTS_HIDDEN). /recommendations adds their cards (run out, wastage, regulars gone quiet, food cost, a thin margin,
 * a cost rise) and `hooks` — one live figure per tile; before 162 runs those parts are simply absent (never a 503 there).
 * /overview adds `noCost` (the share of sales with no cost; costs only) for the page's call-out.
 * A565 (between branches; a viewer who sees every branch — allBranchAccess — and two or more active branches): GET
 * /branches — the branches side by side (sales, the change on each one's own previous period, a day, the average bill,
 * the margin with costs; a branch flagged when it falls) and the stock moves to consider, as plain suggestions with NO
 * quantity and no KES (the owner: "it should be a recommendation so it should not show number"). The work reuses what is
 * there, per branch and kept 5 minutes (shared with that branch's own view): migration 162's analytics_stock_use, 160's
 * analytics_daily_sales, 158's menu (costs only) and 161's item times for every branch (the average price that ranks the
 * moves) — plus two plain reads of the levels elsewhere of the items short somewhere. /recommendations adds the movement
 * cards (at most 3, with the stock-out risks; a move into the branch in view replaces its run-out card) and the
 * underperforming-branch card, softly; the Branches tile's hook. Anyone else: 403 BRANCH_SCOPE, nothing run.
 * A575: GET /together — what sells together (migration 164's analytics_together, ONE call, kept 5 minutes): the pairs in
 * plain words, the top 10, in the business's own way of selling (businesses.type, read once and kept); fewer than 30
 * orders with two or more items: enough false and a note. Quantities only (no cost), for anyone with reports.sales.
 * /recommendations adds one or two together cards, softly (before 164 runs: none, never a 503 there), and every card
 * and tile in the business type's words (a shop's "cost of sales").
 */
import type { Request, Response } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { requirePermission, can, allBranchAccess, inBranchSet } from '../middleware/rbac';
import { maskCustomerContacts } from '../lib/personalData';   // A595
import { supabase } from '../lib/supabase';
import { seesCosts } from '../lib/costAccess';
import { getDayCutoff } from '../lib/dayCutoff';
import { businessDateEAT, businessRangeEAT } from '../lib/businessDay';
import { analyticsEnabled } from '../lib/analyticsAccess';
import { cloudFactsFor } from '../lib/cloudPlan';                   // A612
import { featureBranches } from '../lib/branchBilling';             // A612: premium per branch
import {
  ANALYTICS_OFF_MESSAGE, rangeError, defaultRange, classifyMenu, menuWithoutCosts, summariseHeatmap, summariseLeaks,
  leaksWithoutWastageValue, summariseCredit, buildInsights, previousPeriod, buildOverview, summariseItemTimes,
  allRecommendations, rankRecommendations, buildSummary, valueFound, rangeDays, weekPlan, ITEM_TIMES_LIMIT,
  summariseStockUse, summariseCustomers, buildCosts, tileHooks, noCostShare, STOCK_NOTE_ALL,
  type StockUseRow, type StockUseResult, type CustomerAggRow, type CustomersResult, type CostWatchRow, type CostsResult,
  type StockLevel, type MenuRow, type HeatRow, type LeakRow, type CreditRow, type DailyRow, type MenuResult, type LeaksResult, type CreditResult,
  type ItemTimeRow, type ItemTimesResult,
  summariseTogether, TOGETHER_LIMIT, type TogetherRow, type TogetherResult,
  MAX_BRANCHES, TABLE_TOP, grossMarginPct, moveCandidates, stockMoves, moveSuggestions, compareBranches,
  type BranchInfo, type BranchLevel, type BranchCompare, type StockMove, type Recommendation,
} from '../lib/analyticsRules';

const router = safeRouter();
router.use(requireAuth);
router.use(requireWebSurface);
// A595 (docs/PERMISSIONS-AUDIT.md F7): the Analytics area is its own part of reports.sales (reports.analytics — migration
// 176 gave it to every holder of reports.sales), and customers' phones are masked here without customers.contacts.
router.use(requirePermission('reports.analytics'));
router.use(maskCustomerContacts());

// ── The cache: one answer per business, branch and period, kept CACHE_TTL_MS ──────────────────────────────────────
export const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
let rpcCalls = 0;

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: now, value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });   // a failure is never kept
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return value;
}
/** Tests: forget every kept answer; how many aggregate calls were made. */
export function _analyticsCache() { return { clear: () => cache.clear(), size: () => cache.size, rpcCalls: () => rpcCalls }; }

class NotReady extends Error {}
async function aggregate<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  rpcCalls += 1;
  // A582: a partner's set → the function's _set twin (migration 171: p_branches, no "every branch" case); else as before
  const set = Array.isArray(args.p_branches);
  const rest: Record<string, unknown> = { ...args };
  delete rest.p_branch;
  const { data, error } = set ? await supabase.rpc(`${fn}_set`, rest) : await supabase.rpc(fn, args);
  if (error) {
    // before migration 158 runs the function is not there (PostgREST PGRST202 / Postgres 42883)
    if (error.code === 'PGRST202' || error.code === '42883') throw new NotReady(error.message);
    throw new Error(`${fn}: ${error.message}`);
  }
  return (data ?? []) as T[];
}

// ── The request: flag, period, branch ──────────────────────────────────────────────────────────────────────────────
/**
 * A582: `branches` — a partner's "All my branches" (X-Branch-Id 'mine', two or more branches, never every one): the
 * aggregates run over exactly those (migration 171's <name>_set functions, p_branches; branch null). Absent / null for
 * everyone else, so the owner's calls are exactly as before.
 */
interface Ctx { businessId: string; branch: string | null; branches?: string[] | null; from: string; to: string; start: string; end: string; cutoff: number; costs: boolean }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function context(req: Request, res: Response): Promise<Ctx | null> {
  const businessId = req.businessId;
  if (!businessId) { res.status(403).json({ error: 'No business on this sign-in.' }); return null; }
  if (!(await analyticsEnabled(businessId))) { res.status(403).json({ error: ANALYTICS_OFF_MESSAGE, code: 'ANALYTICS_OFF' }); return null; }

  // the branch: an owner — or an A550 partner of every branch — names one of the business's branches or none (all);
  // anyone else is held to their own
  const q = req.query.branch ?? req.query.branch_id;
  let branch: string | null;
  let branches: string[] | null = null;
  if (inBranchSet(req)) {
    // A582: one of their branches named (?branch=), or every one of theirs — another branch: refused, never shown
    const mine = [...(req.branchSet as string[])];
    const asked = typeof q === 'string' ? q.trim() : '';
    if (asked && asked !== 'all' && asked !== 'mine' && !mine.includes(asked)) { res.status(403).json({ error: 'You can see your own branches only.', code: 'BRANCH_SCOPE' }); return null; }
    branch = asked && mine.includes(asked) ? asked : null;
    if (!branch) branches = mine;
  } else if (allBranchAccess(req)) {
    const asked = typeof q === 'string' ? q.trim() : String(req.headers['x-branch-id'] ?? '').trim();
    branch = asked && asked !== 'all' && asked !== 'mine' ? asked : null;   // A582: 'mine' is a partner's set — never a branch
    if (branch) {
      const { data: b } = UUID.test(branch)
        ? await supabase.from('branches').select('id').eq('id', branch).eq('business_id', businessId).maybeSingle()
        : { data: null };
      if (!b) { res.status(404).json({ error: 'Branch not found.', code: 'BRANCH_NOT_FOUND' }); return null; }
    }
  } else {
    if (!req.branchId) { res.status(403).json({ error: 'Your sign-in has no branch.', code: 'BRANCH_SCOPE' }); return null; }
    const asked = typeof q === 'string' ? q.trim() : '';
    if (asked && asked !== req.branchId) { res.status(403).json({ error: 'You can see your own branch only.', code: 'BRANCH_SCOPE' }); return null; }
    branch = req.branchId;
  }

  // A612 phase 4 (premium per branch): billed per branch, Analytics covers the branches that pay for it (premium or the
  // package) — one named that does not: off for it; none named: those of the branches in view.
  const paying = featureBranches(await cloudFactsFor(businessId).catch(() => null), 'analytics');
  if (paying) {
    (req as { analyticsBranches?: string[] }).analyticsBranches = paying;
    if (branch && !paying.includes(branch)) { res.status(403).json({ error: ANALYTICS_OFF_MESSAGE, code: 'ANALYTICS_OFF' }); return null; }
    if (!branch) {
      const inView = (branches ?? paying).filter((b) => paying.includes(b) && !req.pausedBranches?.has(b));
      if (!inView.length) { res.status(403).json({ error: ANALYTICS_OFF_MESSAGE, code: 'ANALYTICS_OFF' }); return null; }
      branches = inView;
    }
  }

  // the period, in business dates (the owner's day cut-off, as every report)
  const cutoff = await getDayCutoff(businessId, branch);
  const fallback = defaultRange(businessDateEAT(new Date(), cutoff));
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : fallback.from;
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : fallback.to;
  const bad = rangeError(from, to);
  if (bad) { res.status(400).json(bad); return null; }
  const { start, end } = businessRangeEAT(from, to, cutoff);
  return { businessId, branch, branches, from, to, start, end, cutoff, costs: seesCosts(req) };
}

/** A582: what the answer covers, in a cache key: one branch, a partner's set (sorted), or every branch. */
const scopeKey = (c: Ctx) => (c.branch ? c.branch : c.branches?.length ? `set:${[...c.branches].sort().join('+')}` : 'all');
/** A582: the branch arguments of an aggregate: one branch (p_branch), a partner's set (p_branches — aggregate() calls the
 *  function's _set twin of migration 171), or none (every branch). */
const scopeArgs = (c: Ctx): Record<string, unknown> => (c.branch ? { p_branch: c.branch }
  : c.branches?.length ? { p_branches: c.branches } : { p_branch: null });
const key = (what: string, c: Ctx) => `${what}|${c.businessId}|${scopeKey(c)}|${c.from}|${c.to}|${c.cutoff}`;
const period = (c: Ctx) => ({ from: c.from, to: c.to, start: c.start, end: c.end });
const span = (c: Ctx) => ({ p_business: c.businessId, ...scopeArgs(c), p_from: c.start, p_to: c.end });

function menu(c: Ctx): Promise<MenuResult> {
  return cached(key('menu', c), async () => classifyMenu(await aggregate<MenuRow>('analytics_menu_engineering', span(c))));
}
function heatmap(c: Ctx) {
  return cached(key('heatmap', c), async () => summariseHeatmap(await aggregate<HeatRow>('analytics_sales_heatmap', span(c))));
}
function leaks(c: Ctx): Promise<LeaksResult> {
  return cached(key('leaks', c), async () => {
    const rows = await aggregate<LeakRow>('analytics_money_leaks', { ...span(c), p_cutoff: c.cutoff });
    const ids = [...new Set(rows.map((r) => r.cashier_id).filter((x): x is string => !!x))];
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data } = await supabase.from('users').select('id, name').eq('business_id', c.businessId).in('id', ids);
      for (const u of (data ?? []) as Array<{ id: string; name: string | null }>) names[u.id] = u.name || 'Unnamed staff';
    }
    return summariseLeaks(rows, names);
  });
}
// credit ageing is as of NOW (balances are current) — the period does not apply; kept per business and branch.
function credit(c: Ctx): Promise<CreditResult & { asOf: string }> {
  return cached(`credit|${c.businessId}|${scopeKey(c)}`, async () => {
    const asOf = new Date().toISOString();
    return { asOf, ...summariseCredit(await aggregate<CreditRow>('analytics_credit_ageing', { p_business: c.businessId, ...scopeArgs(c), p_as_of: asOf })) };
  });
}
// A553: the previous period of the same length, as its own context (its own cache keys)
function before(c: Ctx): Ctx {
  const p = previousPeriod(c.from, c.to);
  const { start, end } = businessRangeEAT(p.from, p.to, c.cutoff);
  return { ...c, from: p.from, to: p.to, start, end };
}
// A553: sales per business day for the previous period AND this one, in one aggregate call
function daily(c: Ctx, prev: Ctx): Promise<DailyRow[]> {
  return cached(`daily|${c.businessId}|${scopeKey(c)}|${prev.from}|${c.to}|${c.cutoff}`,
    () => aggregate<DailyRow>('analytics_daily_sales', { p_business: c.businessId, ...scopeArgs(c), p_from: prev.start, p_to: c.end, p_cutoff: c.cutoff }));
}
// A558: what sells when — each product by business weekday × hour (the best ITEM_TIMES_LIMIT sellers + a total row)
function itemTimes(c: Ctx): Promise<ItemTimesResult> {
  return cached(key('times', c), async () => summariseItemTimes(
    await aggregate<ItemTimeRow>('analytics_item_times', { ...span(c), p_cutoff: c.cutoff, p_limit: ITEM_TIMES_LIMIT }), c.cutoff));
}
/**
 * A560: the stock levels now of the products in what sells when, at ONE branch (the one in view; every branch in view
 * and only one branch: that one). Tracked products only (track_stock), none sold through a recipe (its stock is the
 * ingredients', which do not map one to one), never a negative level (an item nobody counts). A failed read: none.
 */
function stockLevels(c: Ctx, t: ItemTimesResult): Promise<{ levels: StockLevel[] | null; note: string | null }> {
  return cached(key('stock', c), async () => {
    let branch = c.branch;
    // A582: a partner's set is several branches — stock is counted per branch (never another branch's levels)
    if (!branch && c.branches?.length) return { levels: null, note: 'Pick a branch to see what is running low — stock is counted per branch.' };
    if (!branch) {
      const { data: bs } = await supabase.from('branches').select('id').eq('business_id', c.businessId);
      const list = (bs ?? []) as Array<{ id: string }>;
      if (list.length !== 1) return { levels: null, note: 'Pick a branch to see what is running low — stock is counted per branch.' };
      branch = list[0].id;
    }
    const ids = t.items.map((i) => i.productId).filter((x): x is string => !!x && UUID.test(x));
    if (!ids.length) return { levels: null, note: null };
    try {
      const [{ data: prods, error: e1 }, { data: recipes, error: e2 }] = await Promise.all([
        supabase.from('products').select('id, track_stock').eq('business_id', c.businessId).in('id', ids),
        supabase.from('recipes').select('product_id').eq('business_id', c.businessId).in('product_id', ids),
      ]);
      if (e1 || e2) return { levels: null, note: null };
      const viaRecipe = new Set(((recipes ?? []) as Array<{ product_id: string }>).map((r) => r.product_id));
      const tracked = ((prods ?? []) as Array<{ id: string; track_stock: boolean | null }>)
        .filter((p) => p.track_stock !== false && !viaRecipe.has(p.id)).map((p) => p.id);
      if (!tracked.length) return { levels: [], note: null };
      const { data: rows, error } = await supabase.from('stock_levels').select('product_id, quantity').eq('branch_id', branch).in('product_id', tracked);
      if (error) return { levels: null, note: null };
      return {
        levels: ((rows ?? []) as Array<{ product_id: string; quantity: number | string }>)
          .map((r) => ({ productId: r.product_id, onHand: Number(r.quantity) })).filter((r) => Number.isFinite(r.onHand) && r.onHand >= 0),
        note: null,
      };
    } catch { return { levels: null, note: null }; }
  });
}
const seesCredit = (req: Request) => can(req, 'customers.view', 'customers.credit');

// ── A561: stock use, customers, costs ─────────────────────────────────────────────────────────────────────────────
const daysOf = (c: Ctx) => rangeDays(c.from, c.to) ?? 1;
/** How fast stock goes. Days left needs ONE branch: the one in view, or the only one; more than one in view: no level. */
function stockUse(c: Ctx): Promise<StockUseResult> {
  return cached(key('stockuse', c), async () => {
    let onHandBranch = c.branch;
    if (!onHandBranch && !c.branches?.length) {   // A582: a partner's set — several branches, no level
      const { data: bs } = await supabase.from('branches').select('id').eq('business_id', c.businessId);
      const list = (bs ?? []) as Array<{ id: string }>;
      if (list.length === 1) onHandBranch = list[0].id;
    }
    const p = before(c);
    const rows = await aggregate<StockUseRow>('analytics_stock_use', {
      p_business: c.businessId, ...(onHandBranch ? { p_branch: onHandBranch } : scopeArgs(c)), p_from: c.start, p_to: c.end, p_prev_from: p.start, p_limit: 300,
    });
    return summariseStockUse(rows, daysOf(c), !!onHandBranch, onHandBranch ? null : STOCK_NOTE_ALL);
  });
}
/** Who comes back. Without the customer keys the SQL reads no customer at all (p_with_customers false). */
function customers(c: Ctx, withCustomers: boolean): Promise<CustomersResult> {
  return cached(`${key('customers', c)}|${withCustomers ? 'with' : 'mix'}`, async () => {
    const p = before(c);
    const rows = await aggregate<CustomerAggRow>('analytics_customers', {
      p_business: c.businessId, ...scopeArgs(c), p_from: c.start, p_to: c.end, p_prev_from: p.start, p_cutoff: c.cutoff,
      p_with_customers: withCustomers, p_limit: 200,
    });
    const today = businessDateEAT(new Date(), c.cutoff);
    return summariseCustomers(rows, c.from, c.to, today < c.to ? today : c.to, !withCustomers);
  });
}
/** Costs and margins — only ever called for a caller who may see costs. */
function costs(c: Ctx): Promise<CostsResult> {
  return cached(key('costs', c), async () => {
    const [m, mPrev, watch] = await Promise.all([
      menu(c), menu(before(c)),
      aggregate<CostWatchRow>('analytics_cost_watch', { p_business: c.businessId, ...scopeArgs(c), p_from: c.start, p_to: c.end }),
    ]);
    return buildCosts({ menu: m, menuPrev: mPrev, watch, days: daysOf(c) });
  });
}
/**
 * /recommendations: a part that needs migration 162 (or fails) is left out — never a 503 for the whole answer. Before 162
 * runs, "not there" is kept like an answer (5 minutes, under its own key) so the page's visits do not ask again each time;
 * any other failure is not kept.
 */
function soft<T>(k: string, load: () => Promise<T>): Promise<T | null> {
  return cached(`soft|${k}`, () => load().catch((e) => { if (e instanceof NotReady) return null; throw e; }))
    .catch((e) => { console.error('[analytics] optional part failed:', (e as Error)?.message ?? e); return null; });
}

// ── A565: between branches ───────────────────────────────────────────────────────────────────────────────────────
/** The business's active branches, by name (kept 5 minutes). */
function activeBranches(c: Ctx): Promise<BranchInfo[]> {
  return cached(`branches|${c.businessId}`, async () => {
    const { data, error } = await supabase.from('branches').select('id, name, status').eq('business_id', c.businessId);
    if (error) throw new Error(`branches: ${error.message}`);
    return ((data ?? []) as Array<{ id: string; name: string | null; status: string | null }>)
      .filter((b) => (b.status ?? 'active') !== 'inactive')
      .map((b) => ({ id: b.id, name: b.name || 'Unnamed branch' })).sort((a, b) => a.name.localeCompare(b.name));
  });
}
/** The levels at every branch of the items short somewhere — two plain reads; a failure: none (no move from there). */
async function branchLevels(c: Ctx, list: BranchInfo[], want: { kind: 'product' | 'ingredient'; itemId: string }[], byPiece: Set<string>): Promise<BranchLevel[]> {
  const ids = list.map((b) => b.id);
  const prods = want.filter((w) => w.kind === 'product' && UUID.test(w.itemId)).map((w) => w.itemId).slice(0, 100);
  const ings = want.filter((w) => w.kind === 'ingredient' && UUID.test(w.itemId)).map((w) => w.itemId).slice(0, 100);
  const out: BranchLevel[] = [];
  try {
    const none = Promise.resolve({ data: [] as unknown[], error: null });
    const [p, i] = await Promise.all([
      prods.length ? supabase.from('stock_levels').select('product_id, branch_id, quantity, qty_pieces').in('branch_id', ids).in('product_id', prods) : none,
      ings.length ? supabase.from('ingredient_stock_levels').select('ingredient_id, branch_id, current_stock').eq('business_id', c.businessId).in('branch_id', ids).in('ingredient_id', ings) : none,
    ]);
    if (!p.error) for (const r of (p.data ?? []) as Array<{ product_id: string; branch_id: string; quantity: number | string | null; qty_pieces: number | string | null }>) {
      out.push({ kind: 'product', itemId: r.product_id, branchId: r.branch_id, onHand: Number(byPiece.has(r.product_id) ? r.qty_pieces : r.quantity) });
    }
    if (!i.error) for (const r of (i.data ?? []) as Array<{ ingredient_id: string; branch_id: string; current_stock: number | string | null }>) {
      out.push({ kind: 'ingredient', itemId: r.ingredient_id, branchId: r.branch_id, onHand: Number(r.current_stock) });
    }
  } catch { return []; }
  return out;
}
interface BranchWork { available: boolean; count: number; limited: boolean; compare: BranchCompare | null; moves: StockMove[] | null }
const branchKey = (c: Ctx, within: string[] | null = null) =>
  `branchwork|${c.businessId}|${within ? `set:${[...within].sort().join('+')}` : 'all'}|${c.from}|${c.to}|${c.cutoff}|${c.costs ? 'costs' : 'plain'}`;
/**
 * A582: whose branches the Branches comparison covers — every branch (null) for the owner and a partner of every branch;
 * a partner of some branches (two or more): exactly theirs, whichever is in view; anyone else: undefined (not offered).
 */
function compareWithin(req: Request): string[] | null | undefined {
  const w = compareWithinBranches(req);
  // A612: billed per branch — only the branches that pay for Analytics (context() set them).
  const paying = (req as { analyticsBranches?: string[] }).analyticsBranches;
  if (!paying || w === undefined) return w;
  return (w ?? paying).filter((b) => paying.includes(b));
}
function compareWithinBranches(req: Request): string[] | null | undefined {
  // A612: some branches paused — the owner (a partner of every branch) compares the open ones only.
  if (req.pausedBranches?.size && (req.isOwner || req.allBranches)) return [...(req.openBranches ?? [])];
  if (allBranchAccess(req)) return null;
  if (req.webPartner === true && !req.allBranches && (req.partnerBranches ?? []).length >= 2) return [...req.partnerBranches];
  return undefined;
}
/**
 * Every branch's figures for the period (the first MAX_BRANCHES by name), whatever branch is in view: each branch's daily
 * sales (160), stock use with its levels (162 — before 162: no moves, the comparison still stands), menu (costs only, the
 * margin) and the business's item times (the average price that ranks the moves). Each is the per-branch answer the
 * branch's own view uses, so it is shared through the cache.
 */
function branchWork(c: Ctx, within: string[] | null = null): Promise<BranchWork> {
  return cached(branchKey(c, within), async () => {
    // A582: a partner of some branches compares theirs only — never another branch's figures, name or stock
    const all = (await activeBranches(c)).filter((b) => !within || within.includes(b.id));
    if (all.length < 2) return { available: false, count: all.length, limited: false, compare: null, moves: null };
    const list = all.slice(0, MAX_BRANCHES);
    const per = list.map((b) => ({ ...c, branch: b.id, branches: null }));
    const missing = <T>(p: Promise<T>) => p.catch((e) => { if (e instanceof NotReady) return null; throw e; });
    const [dailies, uses, menus, t] = await Promise.all([
      Promise.all(per.map((cb) => daily(cb, before(cb)))),
      Promise.all(per.map((cb) => missing(stockUse(cb)))),
      c.costs ? Promise.all(per.map((cb) => menu(cb))) : Promise.resolve(null),
      missing(itemTimes({ ...c, branch: null, branches: within })),
    ]);
    const days = daysOf(c);
    let moves: StockMove[] | null = null;
    if (uses.some(Boolean)) {
      const stock = Object.fromEntries(list.map((b, k) => [b.id, uses[k]]));
      const want = moveCandidates({ days, branches: list, stock });
      const byPiece = new Set<string>();   // a product sold by the piece is counted in pieces (162's unit)
      for (const u of uses) for (const x of u?.items ?? []) if (x.kind === 'product' && x.id && x.unit === 'pieces') byPiece.add(x.id);
      const levels = want.length ? await branchLevels(c, list, want, byPiece) : [];
      const prices: Record<string, number> = {};
      for (const x of t?.items ?? []) if (x.productId && x.qty > 0) prices[x.productId] = x.revenue / x.qty;
      moves = stockMoves({ days, branches: list, stock, levels, prices });
    }
    const compare = compareBranches({
      from: c.from, to: c.to, branches: list, daily: Object.fromEntries(list.map((b, k) => [b.id, dailies[k]])),
      margins: menus ? Object.fromEntries(list.map((b, k) => [b.id, grossMarginPct(menus[k])])) : null, moves,
    });
    return { available: true, count: all.length, limited: all.length > list.length, compare, moves };
  });
}
// ── A575: what sells together ─────────────────────────────────────────────────────────────────────────────────────
/** The business's type (restaurant, retail …) — the words of the cards. Kept 5 minutes; a failed read: none (food words). */
function businessType(c: Ctx): Promise<string | null> {
  return cached(`btype|${c.businessId}`, async () => {
    try {
      const { data } = await supabase.from('businesses').select('type').eq('id', c.businessId).maybeSingle();
      return ((data as { type?: string | null } | null)?.type ?? null) || null;
    } catch { return null; }
  });
}
/** The product pairs bought together (ONE aggregate call), in the business type's words. */
function together(c: Ctx): Promise<TogetherResult> {
  return cached(key('together', c), async () => {
    const [rows, type] = await Promise.all([
      aggregate<TogetherRow>('analytics_together', { ...span(c), p_limit: TOGETHER_LIMIT }), businessType(c),
    ]);
    return summariseTogether(rows, type);
  });
}

/** A card as the page gets it: the internal ranking score stays here. */
const forPage = (r: Recommendation): Recommendation => { const { score: _score, ...rest } = r; return rest; };

async function answer(res: Response, work: () => Promise<unknown>) {
  try { res.json(await work()); }
  catch (e) {
    if (e instanceof NotReady) { res.status(503).json({ error: 'Analytics is being set up — try again later.', code: 'ANALYTICS_NOT_READY' }); return; }
    console.error('[analytics]', (e as Error)?.message ?? e);
    res.status(500).json({ error: 'Analytics could not be worked out — try again.' });
  }
}

// GET /api/analytics/menu-engineering?from&to&branch
router.get('/menu-engineering', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => {
    const m = await menu(c);
    return { period: period(c), branchId: c.branch, ...(c.costs ? m : menuWithoutCosts(m)) };
  });
});

// GET /api/analytics/heatmap?from&to&branch
router.get('/heatmap', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => ({ period: period(c), branchId: c.branch, timeZone: 'Africa/Nairobi', ...(await heatmap(c)) }));
});

// GET /api/analytics/money-leaks?from&to&branch
router.get('/money-leaks', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => {
    const l = await leaks(c);
    return { period: period(c), branchId: c.branch, ...(c.costs ? l : leaksWithoutWastageValue(l)) };
  });
});

// GET /api/analytics/credit-ageing?branch — as of now
router.get('/credit-ageing', async (req, res) => {
  if (!seesCredit(req)) { res.status(403).json({ error: 'Forbidden', detail: 'Missing permission: customers.view' }); return; }
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => ({ branchId: c.branch, ...(await credit(c)) }));
});

// GET /api/analytics/overview?from&to&branch — A553: the KPI row (each against the previous period), the daily trend and
// the payment mix. Costs (A490): without them no margin, and wastage (valued at cost) is not in money at risk.
router.get('/overview', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => {
    const p = before(c);
    const [rows, lNow, lPrev, mNow, mPrev] = await Promise.all([
      daily(c, p), leaks(c), leaks(p), c.costs ? menu(c) : Promise.resolve(null), c.costs ? menu(p) : Promise.resolve(null),
    ]);
    return {
      period: period(c), branchId: c.branch,
      ...buildOverview({ from: c.from, to: c.to, daily: rows, leaksNow: lNow, leaksPrev: lPrev, menuNow: mNow, menuPrev: mPrev, costs: c.costs }),
      // A561: the share of sales with no cost (the page's call-out) — costs only
      noCost: c.costs ? noCostShare(mNow) : null,
    };
  });
});

// GET /api/analytics/item-times?from&to&branch — A558: what sells when. Quantities and revenue only (no cost), so the
// same answer for every caller who may see sales.
router.get('/item-times', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => {
    const t = await itemTimes(c);
    return { period: period(c), branchId: c.branch, timeZone: 'Africa/Nairobi', cutoff: c.cutoff, ...t, week: weekPlan(t, c.from, c.to) };
  });
});

// GET /api/analytics/recommendations?from&to&branch — A558: "Do this next" (ranked, each with its estimate and the
// assumption) and "How was this period?". Without costs the menu is never worked out here (every menu rule needs a
// margin) and wastage is out; without customers.view / customers.credit no credit rule.
router.get('/recommendations', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => {
    const p = before(c);
    const [m, mPrev, h, l, lPrev, cr, t, rows] = await Promise.all([
      c.costs ? menu(c) : Promise.resolve(null), c.costs ? menu(p) : Promise.resolve(null), heatmap(c), leaks(c), leaks(p),
      seesCredit(req) ? credit(c) : Promise.resolve(null), itemTimes(c), daily(c, p),
    ]);
    const overview = buildOverview({ from: c.from, to: c.to, daily: rows, leaksNow: l, leaksPrev: lPrev, menuNow: m, menuPrev: mPrev, costs: c.costs });
    const withCustomers = seesCredit(req);
    // A565: between branches — only for a viewer who sees every branch; softly (a failure leaves the cards out)
    const within = compareWithin(req);   // A582: a partner of some branches — theirs
    const bw = within !== undefined ? await soft(branchKey(c, within), () => branchWork(c, within)) : null;
    const branches = bw && bw.available ? bw : null;
    const [stock, su, cu, cw, tg, btype] = await Promise.all([
      stockLevels(c, t), soft(key('stockuse', c), () => stockUse(c)),
      soft(`${key('customers', c)}|${withCustomers ? 'with' : 'mix'}`, () => customers(c, withCustomers)),
      c.costs ? soft(key('costs', c), () => costs(c)) : Promise.resolve(null),
      soft(key('together', c), () => together(c)), businessType(c),   // A575
    ]);
    const today = businessDateEAT(new Date(), c.cutoff);
    const every = allRecommendations({
      days: rangeDays(c.from, c.to) ?? 1, costs: c.costs, menu: m, heatmap: h,
      leaks: c.costs ? l : leaksWithoutWastageValue(l), credit: cr, times: t,
      from: c.from, to: c.to, today, stock: stock.levels, stockUse: su, customers: cu, costWatch: cw,
      moves: branches?.moves ?? null, branchCompare: branches?.compare ?? null, branchInView: c.branch,
      together: tg, businessType: btype,
    });
    const recommendations = rankRecommendations(every);
    return {
      period: period(c), branchId: c.branch, costsHidden: !c.costs,
      summary: buildSummary({ from: c.from, to: c.to, today, overview, recommendations }),
      recommendations: recommendations.map(forPage), found: valueFound(recommendations), stockNote: stock.note,
      // A561: one live figure per tile, and whether a card points there
      hooks: tileHooks({
        costs: c.costs, seesCredit: withCustomers, menu: m, heatmap: h, leaks: l, credit: cr, stockUse: su, customers: cu,
        costWatch: cw, recommendations: every, itemsSold: t.items.length, businessType: btype,
        branches: branches ? {
          count: branches.count, moves: moveSuggestions(branches.moves, c.branch).length,
          underperforming: (branches.compare?.underperforming ?? []).filter((u) => !c.branch || u.id === c.branch).map((u) => ({ name: u.name, change: u.change })),
        } : null,
      }),
    };
  });
});

// GET /api/analytics/stock?from&to&branch — A561: how fast stock goes. Quantities only (no cost), for anyone with
// reports.sales, as A560's stock cards.
router.get('/stock', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => ({ period: period(c), branchId: c.branch, ...(await stockUse(c)) }));
});

// GET /api/analytics/customers?from&to&branch — A561: who comes back (customers.view / customers.credit) and the
// order-type mix with the average bill (anyone with reports.sales; for them no customer is read).
router.get('/customers', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  // A595: the NAMED list is what customers bought (customers.history), or the credit side's own (customers.credit).
  await answer(res, async () => ({ period: period(c), branchId: c.branch, ...(await customers(c, can(req, 'customers.history', 'customers.credit'))) }));
});

// GET /api/analytics/costs?from&to&branch — A561: food cost, the thinnest margins, cost rises, the items with no cost.
router.get('/costs', async (req, res) => {
  if (!seesCosts(req)) { res.status(403).json({ error: 'Costs and margins are hidden for your role.', code: 'COSTS_HIDDEN' }); return; }
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => ({ period: period(c), branchId: c.branch, ...(await costs(c)) }));
});

// GET /api/analytics/branches?from&to — A565: the branches side by side and the stock moves to consider (words only — no
// quantity is sent). Every branch whatever the one in view; the owner or a partner of every branch only.
router.get('/branches', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  // A582: and a partner of two or more branches — their branches only
  const within = compareWithin(req);
  if (within === undefined) { res.status(403).json({ error: 'Comparing branches is for the owner and partners of two or more branches.', code: 'BRANCH_SCOPE' }); return; }
  await answer(res, async () => {
    const w = await branchWork(c, within);
    const suggestions = w.moves ? moveSuggestions(w.moves) : null;
    return {
      period: period(c), branchId: c.branch, available: w.available, branchCount: w.count, limited: w.limited,
      note: w.available ? null : 'Comparing branches needs two or more active branches.',
      compare: w.compare,
      // the suggestions without their internal score: the items, the two branches and the words
      moves: suggestions ? suggestions.slice(0, TABLE_TOP).map(({ score: _s, ...x }) => x) : null,
      movesTotal: suggestions ? suggestions.length : 0,
      movesNote: w.available && !w.moves ? 'Stock moves appear once stock use is set up (Analytics is being set up).' : null,
    };
  });
});

// GET /api/analytics/together?from&to&branch — A575: what sells together. Quantities only (no cost), for anyone with
// reports.sales; the cards' internal list (strong) stays here.
router.get('/together', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => {
    const { strong: _strong, ...t } = await together(c);
    return { period: period(c), branchId: c.branch, businessType: await businessType(c), ...t };
  });
});

// GET /api/analytics/insights?from&to&branch — the rule-based sentences from the four above
router.get('/insights', async (req, res) => {
  const c = await context(req, res); if (!c) return;
  await answer(res, async () => {
    const [m, h, l, cr] = await Promise.all([menu(c), heatmap(c), leaks(c), seesCredit(req) ? credit(c) : Promise.resolve(null)]);
    const insights = buildInsights({
      menu: c.costs ? m : menuWithoutCosts(m), heatmap: h, leaks: c.costs ? l : leaksWithoutWastageValue(l), credit: cr,
    });
    return { period: period(c), branchId: c.branch, insights };
  });
});

export default router;
