/**
 * terminalKey — resolve which physical terminal (drawer) a request belongs to.
 *
 * Mirrors the SQL function shift_terminal_key (migration 63) EXACTLY, so the
 * application and the unique index agree on what "one open session per terminal"
 * means. If these two ever diverge, a session the app thinks is fine will trip
 * the constraint, or vice versa.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 * A shift is a drawer session bound to a terminal, not carried by a cashier.
 * The desktop mints device_id at install and sends it as x-device-id (and in the
 * order body). The web POS has no dedicated hardware drawer per browser, so all
 * web sales in a branch share one logical drawer session keyed 'web:<branchId>'.
 * That is deliberate: a web POS reconciles per branch, a desktop till per device.
 */

import type { Request } from 'express';

/**
 * The device id from a request, normalised.
 *
 * A header sent TWICE arrives joined with a comma. The desktop sent both
 * 'x-device-id' and 'X-Device-Id' — HTTP header names are case-insensitive, so
 * fetch emitted the pair — and every reader here got:
 *
 *   "24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e089095b719"
 *
 * Observed in production 2026-08-09. It reached four places: fleet telemetry
 * (where `WHERE device_id = ?` could never match), `orders.device_id`,
 * `shifts.device_id`, and this terminal key.
 *
 * NORMALISING MATTERS FOR THE ROLLOUT, not just for tidiness. The terminal key
 * feeds migration 63's "one open drawer session per terminal" unique index. A
 * till updated mid-shift would otherwise switch from the joined value to the
 * single one, look like a DIFFERENT terminal, and be allowed a second open
 * drawer against the same physical till. Taking the first value makes an old
 * build and a new one resolve to the same key, so the change is invisible to
 * that index.
 *
 * Body value preferred order is unchanged; only the parsing is fixed.
 */
export function deviceIdFromRequest(req: Request): string {
  const raw =
    (req.headers['x-device-id'] as string | undefined) ??
    (req.body?.device_id as string | undefined) ??
    '';
  // Split before trimming: the join is ", " and the second copy may be truncated
  // by a downstream slice, so only the first is trustworthy.
  return String(raw).split(',')[0].trim();
}

export function terminalKeyFromRequest(req: Request): string {
  const deviceId = deviceIdFromRequest(req);
  const terminalCode = (req.body?.terminal_code as string | undefined)?.trim() || '';
  const branchId = (req as any).branchId || (req.body?.branch_id as string | undefined) || '';
  return terminalKey(deviceId, terminalCode, branchId);
}

/** The pure form, matching the SQL COALESCE order. */
export function terminalKey(deviceId: string, terminalCode: string, branchId: string): string {
  return deviceId || terminalCode || `web:${branchId}`;
}
