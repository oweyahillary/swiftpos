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

export function terminalKeyFromRequest(req: Request): string {
  const deviceId =
    (req.headers['x-device-id'] as string | undefined)?.trim() ||
    (req.body?.device_id as string | undefined)?.trim() ||
    '';
  const terminalCode = (req.body?.terminal_code as string | undefined)?.trim() || '';
  const branchId = (req as any).branchId || (req.body?.branch_id as string | undefined) || '';
  return terminalKey(deviceId, terminalCode, branchId);
}

/** The pure form, matching the SQL COALESCE order. */
export function terminalKey(deviceId: string, terminalCode: string, branchId: string): string {
  return deviceId || terminalCode || `web:${branchId}`;
}
