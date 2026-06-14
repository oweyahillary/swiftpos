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
          return asyncHandler(arg as AsyncHandler);
        }
        if (Array.isArray(arg)) {
          return arg.map(fn =>
            typeof fn === 'function' ? asyncHandler(fn as AsyncHandler) : fn
          );
        }
        return arg;
      });

      return original(...wrapped);
    };
  }

  return router;
}
