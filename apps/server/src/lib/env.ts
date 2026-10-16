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

/** A495: 'refuse' | 'warn' | null for M-Pesa sandbox under NODE_ENV=production. */
export function mpesaSandboxInProductionProblem(
  env: Record<string, string | undefined>,
): 'refuse' | 'warn' | null {
  if (env.NODE_ENV !== 'production') return null;
  if ((env.MPESA_ENVIRONMENT ?? '').trim() !== 'sandbox') return null;
  return env.MPESA_ALLOW_SANDBOX_IN_PRODUCTION === '1' ? 'warn' : 'refuse';
}

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

  // A495: a production server pointed at the Daraja SANDBOX skips the callback IP
  // allowlist (mpesa.ts isAllowedCallbackIp), so anyone who knows the callback URL
  // could mark orders paid. render.yaml pins MPESA_ENVIRONMENT=production, so
  // refusing cannot break the live deploy; a deliberate production-mode staging
  // box that really wants sandbox must say so with MPESA_ALLOW_SANDBOX_IN_PRODUCTION=1
  // (and is then warned loudly on every boot).
  const sandboxRefusal = mpesaSandboxInProductionProblem(process.env);
  if (sandboxRefusal === 'refuse') {
    console.error(
      '\n[env] Refusing to start — MPESA_ENVIRONMENT=sandbox with NODE_ENV=production. ' +
      'The sandbox disables the M-Pesa callback IP allowlist, so a forged callback could mark orders paid. ' +
      'Set MPESA_ENVIRONMENT=production (or, for a staging box only, MPESA_ALLOW_SANDBOX_IN_PRODUCTION=1).\n',
    );
    process.exit(1);
  } else if (sandboxRefusal === 'warn') {
    console.error(
      '[env] WARNING — M-Pesa SANDBOX in production (MPESA_ALLOW_SANDBOX_IN_PRODUCTION=1): ' +
      'the callback IP allowlist is OFF. Never run a live business on this server.',
    );
  }

  // Advisory, not fatal: these degrade a feature rather than break the server,
  // and refusing to trade because nobody configured WhatsApp would be absurd.
  const optional: Array<[string, string]> = [
    // Email: Resend is the primary; SendGrid (A352, HTTPS) and SMTP are the backups — Render blocks SMTP (A54).
    ['RESEND_API_KEY',     'the primary email provider is missing; emails go through the backups (SendGrid / SMTP) only'],
    ['SENDGRID_API_KEY',   'no SendGrid backup: if Resend refuses an email, only SMTP (blocked on Render) is left'],
    ['APP_ENCRYPTION_KEY', 'stored M-Pesa credentials cannot be decrypted'],
    ['CORS_ORIGINS',       'the dashboard origin allowlist falls back to its built-in default'],
    // A378: the root the clients' own sign-in addresses sit under (africanfries.<root>), e.g. zaptill.co.ke.
    ['TENANT_ROOT_DOMAIN', 'clients\' own sign-in addresses (subdomains) are off — everyone signs in on the main address'],
    // A348: the tills' update feed reads the releases with it; not needed while the repository is public.
    ['GITHUB_RELEASES_TOKEN', 'desktop updates work only while the repository is public'],
    // A383: the watchdog tells the admin — Telegram and email together. Either alone works.
    ['TELEGRAM_BOT_TOKEN', 'the watchdog sends no Telegram alerts (set TELEGRAM_CHAT_ID too)'],
    ['ADMIN_ALERT_EMAIL',  'the watchdog sends no alert emails'],
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
