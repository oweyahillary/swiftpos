/**
 * A506: the error the web POS / manager portal shows for a refused cloud call (posApi).
 *
 * The cloud's own words are kept (`error`), with its `code` and the HTTP `status` carried on the Error so a screen can
 * tell a refusal apart (SELF_APPROVAL, PIN_LOCKED, OWNER_ONLY …). A permission refusal from requirePermission answers
 * `{ error: 'Forbidden', detail: 'Missing permission: menu.costs' }` — the person saw the bare word "Forbidden"; they
 * now read that they lack a permission, and which.
 */
export type PosError = Error & { code?: string; status?: number; detail?: string };

export function posError(json: unknown, status: number): PosError {
  const body = (json && typeof json === 'object' ? json : {}) as { error?: unknown; code?: unknown; detail?: unknown };
  const error = typeof body.error === 'string' && body.error ? body.error : `Request failed: ${status}`;
  const detail = typeof body.detail === 'string' ? body.detail : undefined;
  const missing = detail?.match(/^Missing permission: (.+)$/)?.[1];
  const message = error === 'Forbidden'
    ? (missing ? `You don't have permission to do this (${missing}). Ask the owner.` : detail || 'You don\'t have permission to do this.')
    : error;
  const err = new Error(message) as PosError;
  if (typeof body.code === 'string') err.code = body.code;
  err.status = status;
  if (detail) err.detail = detail;
  return err;
}
