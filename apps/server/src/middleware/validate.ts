import type { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * validate(schema) — Express middleware that parses req.body through a Zod schema.
 * On failure, returns 400 with a structured errors array.
 * On success, req.body is replaced with the parsed (type-safe) value.
 *
 * Usage:
 *   router.post('/', requireAuth, validate(CreateOrderSchema), async (req, res) => { ... });
 */
export function validate<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation failed',
        // Zod 4 renamed ZodError.errors -> .issues. Reading .errors gave
        // undefined, so this .map threw and every 400 surfaced as a 500.
        errors: result.error.issues.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
