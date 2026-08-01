/**
 * envGuard.ts — run validateEnv() as an import side effect.
 *
 * This exists because of module evaluation order. Imports are hoisted and
 * evaluated before ANY statement in the importing module, so calling
 * validateEnv() in the body of index.ts would run after './routes' had already
 * been evaluated — and routes/tech.ts throws at import on a missing
 * TECH_HMAC_SECRET. The clear, complete report would arrive after the
 * single-line crash it exists to replace.
 *
 * Importing this module for its side effect, ahead of './routes', is what makes
 * the check happen first. Keep it immediately below 'dotenv/config' in
 * index.ts, and above everything else.
 */
import { validateEnv } from './env';

validateEnv();
