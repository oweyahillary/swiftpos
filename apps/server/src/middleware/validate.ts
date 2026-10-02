import type { Request, Response, NextFunction } from 'express';
import { z, ZodObject, ZodSchema, ZodError } from 'zod';

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

/**
 * validateLoose(schema) — like validate(), but validates the KNOWN fields and
 * PASSES unknown fields through untouched (`.catchall(z.unknown())`). Use on
 * routes that read more of req.body than the schema declares (auth device fields,
 * product tax fields, …) so validation never silently strips a live field (A157).
 */
export function validateLoose(schema: ZodObject<any>) {
  return validate(schema.catchall(z.unknown()) as unknown as ZodSchema);
}
