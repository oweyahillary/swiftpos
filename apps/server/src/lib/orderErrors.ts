/**
 * orderErrors — turn a Postgres error from create_order_atomic into a decision.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * It was eleven lines inline in orders.ts, and everything it did not name fell
 * through to `throw createErr` → sendError → "Failed to create order (ref: …)".
 * One sentence for a bad foreign key, a malformed uuid, and a dead database.
 *
 * Eight of Beryl's sales died in that branch on 2026-08-07 and took three
 * sessions to diagnose, because the message never said which column the
 * database objected to. Extracted so the mapping can be driven by a test
 * directly rather than modelled by one — see tests/order-error-classification.
 *
 * STATUS CHOICE
 * -------------
 * syncEngine.ts:1190 increments `attempts` on every non-2xx/401/409 alike, so a
 * permanently-bad row burns five retries whatever we return. The status is
 * therefore chosen for what it tells a HUMAN reading `last_error`:
 *
 *   422  this payload can never succeed — stop looking at the network
 *   400  the client sent legs that do not reconcile (the RPC's own guard)
 *   500  we do not know; the log now carries the SQLSTATE
 */

export interface OrderErrorVerdict {
  status: number;
  /** Safe, client-facing sentence. */
  message: string;
  /** Machine-readable code for the till. */
  code?: string;
  /** Full Postgres detail — logged always, returned outside production. */
  detail: string;
  /** True when the caller should rethrow so sendError logs it as unhandled. */
  rethrow?: boolean;
}

export interface PgLikeError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/** Everything the log needs, in one line, from any of Postgres' error shapes. */
export function describePgError(err: PgLikeError): string {
  return [err?.message, err?.details, err?.hint].filter(Boolean).join(' | ');
}

/**
 * Classify. Note what is NOT handled here: 23505 (duplicate) needs a database
 * read to tell an idempotent retry from an order-number collision, so it stays
 * in orders.ts where that read already happens.
 */
export function classifyOrderCreateError(err: PgLikeError): OrderErrorVerdict {
  const detail = describePgError(err);
  const code   = err?.code;

  // The RPC's own reconciliation guard. The client sent legs that do not add
  // up to total + tip; its message is safe and specific, so it is passed through.
  if (code === '23514' || /payment legs sum/.test(err?.message ?? '')) {
    return { status: 400, message: err?.message ?? 'Payment legs do not reconcile', detail };
  }

  // Foreign key. On public.orders the live constraints are cashier_id → users,
  // shift_id → shifts, branch_id → branches, customer_id → customers,
  // discount_id → discounts, pump_id → pumps.
  //
  // cashier_id is the one that bites: a desktop owner token can carry an
  // auth.users id instead of a public.users id when the owner's users row is
  // not resolved at login. That id is not in public.users, so EVERY push under
  // that session fails — and /refresh reuses userId, so it never self-heals.
  if (code === '23503') {
    return {
      status: 422,
      message: 'This sale references a record the server does not have. It cannot be accepted as-is.',
      code: 'ORDER_FK_VIOLATION',
      detail,
    };
  }

  // A malformed uuid or timestamp reaching one of the RPC's bare casts.
  // Migration 69 exists because of exactly this on pump_id. created_at is the
  // remaining exposure, because only the OFFLINE path populates it.
  if (code === '22P02' || code === '22007' || code === '22008') {
    return {
      status: 422,
      message: 'This sale contains a value the server could not read (a date or an id).',
      code: 'ORDER_MALFORMED_VALUE',
      detail,
    };
  }

  if (code === '23502') {
    return {
      status: 422,
      message: 'This sale is missing something the server requires.',
      code: 'ORDER_MISSING_FIELD',
      detail,
    };
  }

  // Unknown. Generic to the client, but the caller logs the SQLSTATE — which is
  // the single thing that was missing for three sessions.
  return {
    status: 500,
    message: 'Failed to create order',
    detail,
    rethrow: true,
  };
}
