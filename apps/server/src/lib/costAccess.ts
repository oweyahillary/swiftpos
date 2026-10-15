/**
 * costAccess.ts — A490: cost prices, margins and profit are not SENT to someone who may not see them.
 *
 * Owner, 2026-10-15: "dont just focus on reports break even other views and how to limit what users see". Rule 4 of
 * docs/PERMISSIONS-A490.md: data a person may not see is not sent (the cloud strips it), not merely hidden.
 *
 * Who sees cost figures: the owner, `menu.costs` (cost prices wherever they appear) or `reports.costs` (costs, margins
 * and profit). Everyone else gets the same answer with the cost fields removed — the screens show a dash.
 *
 * The fields stripped (by name, anywhere in the response — objects nested in arrays and embeds included):
 *   COST_FIELDS: cost_price, unit_cost, old_unit_cost, new_unit_cost, avg_cost, average_cost, total_cost, cost_value,
 *                margin, margin_pct, gross_margin, gross_margin_pct, food_cost, food_cost_pct
 * plus, per router, names that are a cost figure THERE but not everywhere (a wastage line's `value`, a purchase order's
 * `total_amount`, a stock count's `variance_value`, a batch's `value`, a waste summary's `cost`).
 */
import type { Request, Response, NextFunction } from 'express';
import { can } from '../middleware/rbac';

export const COST_FIELDS: readonly string[] = [
  'cost_price', 'unit_cost', 'old_unit_cost', 'new_unit_cost', 'avg_cost', 'average_cost', 'total_cost', 'cost_value',
  'margin', 'margin_pct', 'gross_margin', 'gross_margin_pct', 'food_cost', 'food_cost_pct',
];

/** May this caller see cost prices and margins? The owner always may. */
export function seesCosts(req: Request): boolean {
  return can(req, 'menu.costs', 'reports.costs');
}

/** A copy of `value` without the named fields, at any depth. Dates and other non-plain objects are kept as they are. */
export function stripFields<T>(value: T, fields: ReadonlySet<string>, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripFields(v, fields, depth + 1)) as unknown as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (fields.has(k)) continue;
    out[k] = stripFields(v, fields, depth + 1);
  }
  return out as T;
}

/** The cost fields stripped from `value` when the caller may not see costs. */
export function withoutCosts<T>(req: Request, value: T, extra: readonly string[] = []): T {
  if (seesCosts(req)) return value;
  return stripFields(value, new Set([...COST_FIELDS, ...extra]));
}

/**
 * Router middleware: every JSON answer of the router goes out without cost fields for a caller who may not see them.
 * `extra` names the fields that are a cost figure in this router only.
 */
export function stripCostsUnlessAllowed(extra: readonly string[] = []) {
  const fields = new Set([...COST_FIELDS, ...extra]);
  return (req: Request, res: Response, next: NextFunction): void => {
    const json = res.json.bind(res);
    let decided: boolean | null = null;
    res.json = ((body: unknown) => {
      if (decided === null) decided = seesCosts(req);
      return json(decided || res.statusCode >= 400 ? body : stripFields(body, fields));
    }) as Response['json'];
    next();
  };
}
