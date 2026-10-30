/**
 * internalCall.ts — A602: run an existing route handler for one item of a bigger request, inside this process.
 *
 * The bulk history backfill (routes/backfill.ts) carries up to 500 sales and the drawers and days they need. Each must go
 * through EXACTLY the rules the POS's normal push meets (POST /api/orders, POST /api/sync/push) — not a copy of them. So the
 * handler itself is called, with a request that is the batch's own (the same session, the same device, the same
 * business: Object.create keeps every field requireAuth set) but for this item's body, path and idempotency key, and an
 * answer that is captured instead of sent. One HTTP call, one log line; the business rules are the handler's.
 *
 * Only what the handlers use is modelled: status / json / send / set / setHeader / getHeader / locals / headersSent.
 */
import type { NextFunction, Request } from 'express';

export interface Captured { status: number; body: any; headers: Record<string, string> }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChainFn = (req: any, res: any, next: NextFunction) => unknown;

/** The batch's request, for one item: own body, path and headers; everything else (the session) inherited. */
export function subRequest(parent: Request, o: { url: string; originalUrl: string; body: unknown; headers?: Record<string, string>; extra?: Record<string | symbol, unknown> }): Request {
  const sub = Object.create(parent) as Request;
  const headers: Record<string, unknown> = { ...parent.headers };
  delete headers['content-length']; delete headers['content-encoding'];
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v;
  const own = (value: unknown) => ({ value, writable: true, enumerable: true, configurable: true });
  Object.defineProperties(sub, {
    url: own(o.url), originalUrl: own(o.originalUrl), method: own('POST'), body: own(o.body), headers: own(headers),
    params: own({}), query: own({}),
  });
  for (const k of Reflect.ownKeys(o.extra ?? {})) Object.defineProperty(sub, k, own((o.extra as Record<string | symbol, unknown>)[k as string]));
  return sub;
}

/** An answer that is kept, not sent. */
export function captureResponse(): { res: any; captured: () => Captured } {
  const res: any = {
    statusCode: 200, body: undefined as unknown, headersSent: false, locals: {} as Record<string, unknown>, _headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    sendStatus(c: number) { this.statusCode = c; this.headersSent = true; return this; },
    json(b: unknown) { this.body = b; this.headersSent = true; return this; },
    send(b: unknown) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
    set(k: string | Record<string, string>, v?: string) {
      if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) this._headers[a.toLowerCase()] = String(b); }
      else this._headers[String(k).toLowerCase()] = String(v);
      return this;
    },
    header(k: string, v?: string) { return this.set(k, v); },
    setHeader(k: string, v: string) { this._headers[String(k).toLowerCase()] = String(v); return this; },
    getHeader(k: string) { return this._headers[String(k).toLowerCase()]; },
    on() { return this; }, once() { return this; },
  };
  return { res, captured: () => ({ status: res.statusCode, body: res.body, headers: { ...res._headers } }) };
}

/**
 * Run middleware then the handler, as Express would: each calls next() to pass on, or answers. A handler that throws is
 * thrown (the caller decides what that means for this item). The answer captured.
 */
export async function runChain(chain: ChainFn[], req: Request): Promise<Captured> {
  const { res, captured } = captureResponse();
  for (const fn of chain) {
    let nexted = false; let err: unknown = null;
    await fn(req, res, ((e?: unknown) => { nexted = true; err = e ?? null; }) as NextFunction);
    if (err) throw err;
    if (!nexted || res.headersSent) break;
  }
  return captured();
}
