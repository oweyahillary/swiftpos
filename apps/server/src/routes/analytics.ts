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
 * period (a request already in flight is shared, not repeated); the page never polls. Costs, margins and the wastage
 * value go only to a caller who may see costs (A490 seesCosts); credit ageing needs customers.view or customers.credit.
 */
import type { Request, Response } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { requirePermission, can } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { seesCosts } from '../lib/costAccess';
import { getDayCutoff } from '../lib/dayCutoff';
import { businessDateEAT, businessRangeEAT } from '../lib/businessDay';
import { analyticsEnabled } from '../lib/analyticsAccess';
import {
  ANALYTICS_OFF_MESSAGE, rangeError, defaultRange, classifyMenu, menuWithoutCosts, summariseHeatmap, summariseLeaks,
  leaksWithoutWastageValue, summariseCredit, buildInsights,
  type MenuRow, type HeatRow, type LeakRow, type CreditRow, type MenuResult, type LeaksResult, type CreditResult,
} from '../lib/analyticsRules';

const router = safeRouter();
router.use(requireAuth);
router.use(requireWebSurface);
router.use(requirePermission('reports.sales'));

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
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    // before migration 158 runs the function is not there (PostgREST PGRST202 / Postgres 42883)
    if (error.code === 'PGRST202' || error.code === '42883') throw new NotReady(error.message);
    throw new Error(`${fn}: ${error.message}`);
  }
  return (data ?? []) as T[];
}

// ── The request: flag, period, branch ──────────────────────────────────────────────────────────────────────────────
interface Ctx { businessId: string; branch: string | null; from: string; to: string; start: string; end: string; cutoff: number; costs: boolean }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function context(req: Request, res: Response): Promise<Ctx | null> {
  const businessId = req.businessId;
  if (!businessId) { res.status(403).json({ error: 'No business on this sign-in.' }); return null; }
  if (!(await analyticsEnabled(businessId))) { res.status(403).json({ error: ANALYTICS_OFF_MESSAGE, code: 'ANALYTICS_OFF' }); return null; }

  // the branch: an owner names one of their branches or none (all); anyone else is held to their own
  const q = req.query.branch ?? req.query.branch_id;
  let branch: string | null;
  if (req.isOwner) {
    const asked = typeof q === 'string' ? q.trim() : String(req.headers['x-branch-id'] ?? '').trim();
    branch = asked && asked !== 'all' ? asked : null;
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

  // the period, in business dates (the owner's day cut-off, as every report)
  const cutoff = await getDayCutoff(businessId, branch);
  const fallback = defaultRange(businessDateEAT(new Date(), cutoff));
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : fallback.from;
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : fallback.to;
  const bad = rangeError(from, to);
  if (bad) { res.status(400).json(bad); return null; }
  const { start, end } = businessRangeEAT(from, to, cutoff);
  return { businessId, branch, from, to, start, end, cutoff, costs: seesCosts(req) };
}

const key = (what: string, c: Ctx) => `${what}|${c.businessId}|${c.branch ?? 'all'}|${c.from}|${c.to}|${c.cutoff}`;
const period = (c: Ctx) => ({ from: c.from, to: c.to, start: c.start, end: c.end });
const span = (c: Ctx) => ({ p_business: c.businessId, p_branch: c.branch, p_from: c.start, p_to: c.end });

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
  return cached(`credit|${c.businessId}|${c.branch ?? 'all'}`, async () => {
    const asOf = new Date().toISOString();
    return { asOf, ...summariseCredit(await aggregate<CreditRow>('analytics_credit_ageing', { p_business: c.businessId, p_branch: c.branch, p_as_of: asOf })) };
  });
}
const seesCredit = (req: Request) => can(req, 'customers.view', 'customers.credit');

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
