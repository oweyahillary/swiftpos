/**
 * sendError — one safe way to return an error response.
 *
 * Problem it solves: handlers used to do `res.status(500).json({ error: err.message })`,
 * which leaks internal detail (DB constraint names, column names, stack hints) to
 * the client. This helper logs the full detail server-side with a short reference
 * id and returns a generic, client-safe message in production. In non-production
 * the detail is included in the response to keep debugging fast.
 *
 * Usage:
 *   if (error) { sendError(res, error); return; }                       // 500
 *   sendError(res, err, { message: 'Client creation failed' });         // custom 500 message
 *   sendError(res, error, { status: 502, message: 'Upstream failed' }); // custom status
 *
 * The client-facing `error` is always a safe string; a `ref` is included so a
 * user can quote it and you can grep the logs for the matching `[error <ref>]`.
 * Intentional user-facing 4xx messages should stay as normal res.json — this
 * helper is for unexpected/internal errors you don't want to expose verbatim.
 */
import type { Response } from 'express';
import crypto from 'node:crypto';

const IS_PROD = process.env.NODE_ENV === 'production';

interface SendErrorOptions {
  /** HTTP status code (default 500). */
  status?: number;
  /** Safe, client-facing message. Falls back to a generic one for the status. */
  message?: string;
  /** Optional machine-readable code for the client (e.g. 'ACCOUNT_INACTIVE'). */
  code?: string;
}

const DEFAULT_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable request',
  429: 'Too many requests',
  500: 'Something went wrong',
  502: 'Upstream service error',
  503: 'Service unavailable',
};

/** Build a full, loggable description from any error shape. */
function describe(error: unknown): string {
  if (error == null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'object') {
    // Supabase/PostgREST errors: { message, details, hint, code }
    const e = error as Record<string, unknown>;
    const parts = [e.message, e.details, e.hint, e.code].filter(Boolean).map(String);
    if (parts.length) return parts.join(' | ');
    try { return JSON.stringify(error); } catch { return String(error); }
  }
  return String(error);
}

export function sendError(res: Response, error: unknown, opts: SendErrorOptions = {}): void {
  const status        = opts.status ?? 500;
  const publicMessage = opts.message ?? DEFAULT_MESSAGES[status] ?? 'Request failed';
  const ref           = crypto.randomBytes(4).toString('hex');

  // Full detail goes to the server log, keyed by ref — never to the client in prod.
  console.error(`[error ${ref}] ${status} — ${describe(error)}`);

  const body: Record<string, unknown> = { error: publicMessage, ref };
  if (opts.code) body.code = opts.code;
  if (!IS_PROD)  body.detail = describe(error); // dev-only, to aid debugging

  res.status(status).json(body);
}
