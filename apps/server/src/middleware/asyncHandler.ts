/**
 * asyncHandler — wraps async route handlers with automatic error catching.
 *
 * Without this, an unexpected throw inside an async handler (network timeout,
 * null dereference, JSON parse error) silently hangs the request or crashes
 * the process. With this, all unhandled errors are forwarded to Express's
 * global error handler which returns { error: 'Internal server error' }.
 *
 * Usage — replace:
 *   router.get('/path', async (req, res) => { ... })
 * With:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }))
 *
 * Or use the patched router (preferred — zero per-handler changes):
 *   import { safeRouter } from '../middleware/asyncHandler';
 *   const router = safeRouter();
 *   router.get('/path', async (req, res) => { ... })  // same syntax, auto-wrapped
 */

import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Wraps a single async handler — use when adding try/catch to one specific
 * handler inline, e.g. where you want custom error handling.
 */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * safeRouter — returns an Express Router where every async handler registered
 * via .get/.post/.put/.patch/.delete is automatically wrapped with asyncHandler.
 *
 * Drop-in replacement for Router():
 *   const router = safeRouter();   // instead of Router()
 *
 * All existing route definitions work unchanged — the wrapper is invisible.
 * Middleware arrays (e.g. [requireAuth, handler]) are handled correctly.
 */
export function safeRouter(): Router {
  const router = Router();

  const methods = ['get', 'post', 'put', 'patch', 'delete', 'use'] as const;

  for (const method of methods) {
    const original = router[method].bind(router) as (...args: unknown[]) => Router;

    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]): Router => {
      // Wrap any function argument that looks like an async route handler.
      // Middleware arrays (e.g. [requireAuth, requirePermission('x'), handler])
      // are unpacked so each function is individually wrapped.
      const wrapped = args.map(arg => {
        if (typeof arg === 'function') {
          // Express identifies an ERROR handler by arity: fn.length === 4
          // (err, req, res, next). Wrapping it in a 3-arg arrow would drop it to
          // arity 3, so Express would treat it as ordinary middleware and never
          // route errors to it (finding #18). Pass 4-arg functions through
          // untouched — an error handler is synchronous-signalling by contract,
          // and asyncHandler's catch(next) is exactly what an error handler must
          // NOT do (it would re-enter the error pipeline). Only wrap 0–3 arg
          // handlers, which are the async route handlers this wrapper is for.
          if ((arg as Function).length >= 4) return arg;
          return asyncHandler(arg as AsyncHandler);
        }
        if (Array.isArray(arg)) {
          return arg.map(fn => {
            if (typeof fn !== 'function') return fn;
            if ((fn as Function).length >= 4) return fn;
            return asyncHandler(fn as AsyncHandler);
          });
        }
        return arg;
      });

      return original(...wrapped);
    };
  }

  return router;
}
