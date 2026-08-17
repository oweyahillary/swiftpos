/**
 * env.ts — validate the environment once, at boot, before anything imports a
 * module that throws on a missing variable. Audit H10.
 *
 * The failure this replaces: several modules throw at import time for a missing
 * secret, so a deploy missing one dies with a single-line stack trace naming a
 * single variable. You fix it, redeploy, and the next module throws naming the
 * next one. render.yaml was missing nineteen variables that the code reads, so
 * that loop could run a long time.
 *
 * This reports EVERY problem at once, so one round trip is enough.
 *
 * ── THE ONE THAT IS NOT ABOUT CONVENIENCE ───────────────────────────────────
 * MPESA_ENVIRONMENT unset used to default to 'sandbox', and isAllowedCallbackIp
 * short-circuits to `true` for anything that is not 'production'. A live deploy
 * that forgot the variable therefore accepted a payment callback from ANY IP —
 * anyone who knew the callback URL could mark orders paid — while otherwise
 * behaving normally. It is required explicitly in production for that reason,
 * and mpesa.ts now fails closed rather than open.
 */

import { z } from 'zod';

// zod v4 replaced `required_error` / `invalid_type_error` with a single `error`.
const nonEmpty = (name: string) =>
  z.string({ error: `${name} is not set` }).min(1, `${name} is empty`);

/** Required everywhere, including local development. */
const base = z.object({
  // lib/supabase.ts throws at import without these.
  SUPABASE_URL:              nonEmpty('SUPABASE_URL').url('SUPABASE_URL must be a URL'),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty('SUPABASE_SERVICE_ROLE_KEY'),
  // Signing keys for the two token families. Both throw at import.
  JWT_SECRET:                nonEmpty('JWT_SECRET').min(16, 'JWT_SECRET should be at least 16 characters'),
  ADMIN_JWT_SECRET:          nonEmpty('ADMIN_JWT_SECRET').min(16, 'ADMIN_JWT_SECRET should be at least 16 characters'),
  // TECH_HMAC_SECRET retired (A113): tech tokens are v2 Ed25519, verified with
  // TECH_SIGNING_PUBLIC_KEY; no HMAC secret is read any more.
});

/**
 * Additionally required when NODE_ENV=production.
 *
 * Kept separate so local development does not need M-Pesa credentials or an
 * Ed25519 keypair to boot — a barrier to running the thing locally is a barrier
 * to fixing it.
 */
const production = z.object({
  // techToken.ts refuses to start in production without an explicitly
  // provisioned keypair, rather than generating an ephemeral one.
  TECH_SIGNING_PRIVATE_KEY: nonEmpty('TECH_SIGNING_PRIVATE_KEY'),
  TECH_SIGNING_PUBLIC_KEY:  nonEmpty('TECH_SIGNING_PUBLIC_KEY'),
  // No default permitted. See the note at the top of this file.
  MPESA_ENVIRONMENT: z.enum(['sandbox', 'production'], {
    error:
      'MPESA_ENVIRONMENT must be set to exactly "sandbox" or "production". ' +
      'An unset value previously meant sandbox, which disables the callback IP allowlist.',
  }),
});

export type ServerEnv = z.infer<typeof base> & Partial<z.infer<typeof production>>;

/**
 * Validates and returns the environment, or exits.
 *
 * Exits rather than throws: this runs before the HTTP listener exists, so there
 * is nothing to serve a 500 from, and a process that keeps running while unable
 * to sign a token is worse than one that stopped with a clear reason.
 */
export function validateEnv(): ServerEnv {
  const isProd = process.env.NODE_ENV === 'production';
  const schema = isProd ? base.merge(production) : base;
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues;
    console.error(
      `\n[env] Refusing to start — ${issues.length} environment problem(s) ` +
      `(NODE_ENV=${process.env.NODE_ENV ?? 'unset'}):\n`,
    );
    for (const i of issues) {
      console.error(`  • ${String(i.path[0] ?? '(root)')}: ${i.message}`);
    }
    console.error(
      '\nEvery variable the server reads is listed in render.yaml. Set the ones above ' +
      'and redeploy.\n',
    );
    process.exit(1);
  }

  // Advisory, not fatal: these degrade a feature rather than break the server,
  // and refusing to trade because nobody configured WhatsApp would be absurd.
  const optional: Array<[string, string]> = [
    ['RESEND_API_KEY',     'daily summary and notification emails will fall back to SMTP'],
    ['APP_ENCRYPTION_KEY', 'stored M-Pesa credentials cannot be decrypted'],
    ['CORS_ORIGINS',       'the dashboard origin allowlist falls back to its built-in default'],
  ];
  const absent = optional.filter(([k]) => !process.env[k]);
  if (absent.length) {
    console.warn(
      '[env] Not set (the server will run, with reduced function):\n' +
      absent.map(([k, why]) => `  • ${k} — ${why}`).join('\n'),
    );
  }

  return parsed.data as ServerEnv;
}
