// priceOps.ts — A166, day-to-day bulk price editing.
//
// The money math for "all sodas +20", "+10% on drinks", "round to nearest 10".
// Pure + tested, and used by BOTH the preview and the apply path of
// /api/products/bulk-price, so the old→new prices a user confirms in the preview
// are exactly what gets written — no separate client-side calculation to drift.
//
// Guards are deliberate: a bulk op that silently produced a negative or absurd
// price would mis-price a whole menu, so anything invalid returns an error and is
// shown in the preview rather than applied.

export type PriceOp =
  | { type: 'set';     value: number }   // set every selected item to value
  | { type: 'plus';    value: number }   // add value (negative = subtract)
  | { type: 'percent'; value: number }   // change by value% (negative = discount)
  | { type: 'round';   value: number };  // round to the nearest multiple of value

export type PriceOpResult = { next: number } | { error: string };

/** Round to 2 dp without binary-float drift (e.g. 1.005 → 1.01). */
function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function applyPriceOp(current: number, op: PriceOp): PriceOpResult {
  const cur = Number(current);
  if (!Number.isFinite(cur) || cur < 0) return { error: 'current price is invalid' };
  if (!op || !Number.isFinite(op.value)) return { error: 'operation value is invalid' };

  let next: number;
  switch (op.type) {
    case 'set':
      next = op.value;
      break;
    case 'plus':
      next = cur + op.value;
      break;
    case 'percent':
      if (op.value < -100) return { error: 'a discount cannot exceed 100%' };
      next = cur * (1 + op.value / 100);
      break;
    case 'round': {
      if (!(op.value > 0)) return { error: 'round step must be greater than 0' };
      next = Math.round(cur / op.value) * op.value;
      break;
    }
    default:
      return { error: `unknown operation: ${(op as any).type}` };
  }

  next = money(next);
  if (!Number.isFinite(next) || next < 0) return { error: 'result would be a negative price' };
  return { next };
}

/** Parse a raw op from a request body into a typed PriceOp, or an error. */
export function parsePriceOp(raw: any): PriceOp | { error: string } {
  const type = String(raw?.type ?? '').trim().toLowerCase();
  const value = Number(raw?.value);
  if (!['set', 'plus', 'percent', 'round'].includes(type)) {
    return { error: 'op.type must be set, plus, percent or round' };
  }
  if (!Number.isFinite(value)) return { error: 'op.value must be a number' };
  return { type, value } as PriceOp;
}
