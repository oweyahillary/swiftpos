/**
 * seed-business.mjs — create a test business + owner from nothing (A189, step 1).
 *
 * The E2E suite assumes an owner already exists (you fill OWNER_EMAIL/PASSWORD by
 * hand). This bootstraps one: it creates a GoTrue auth user, then calls the real
 * onboarding route to build the business, branch, roles and owner row — exactly
 * what a human signup does. `seed-users.setup.ts` (staff PINs) runs AFTER this.
 *
 * Dependency-free on purpose — raw fetch to the GoTrue admin API and your API.
 * That makes it portable: Supabase cloud today, a SELF-HOSTED Supabase stack on a
 * VPS tomorrow, or a CI local stack. It is also the tool to bootstrap the first
 * business+owner on a fresh self-hosted deployment.
 *
 * Run (from e2e/):   node --env-file=.env seed/seed-business.mjs
 * Or set env directly:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (required — service key creates the user)
 *   API_BASE_URL                              (default http://localhost:4000)
 *   OWNER_EMAIL, OWNER_PASSWORD               (optional — generated if unset, then
 *                                              written back to e2e/.env for the specs)
 *
 * ── STATUS: iteration 1, NOT yet run against a live stack. ────────────────────
 * Written to the read contract (onboarding.ts + GoTrue admin REST). Validate by
 * running it against a local API + Supabase (or the CLI local stack) and tighten
 * from there — see docs/E2E-CI-PLAN.md. Expect small fixes on first run.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(HERE, '..', '.env');

const SUPABASE_URL = req('SUPABASE_URL');
const SERVICE_KEY  = req('SUPABASE_SERVICE_ROLE_KEY');
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

const OWNER_EMAIL    = process.env.OWNER_EMAIL    || 'e2e-owner@swiftpos.test';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'E2eOwner!Test123';

// Safety: this creates a real business row. Never let it run against production by
// accident — require an explicit opt-in (the CI job / local test env sets it).
if (process.env.SEED_ALLOW !== '1') {
  console.error(
    `✗ Refusing to seed without SEED_ALLOW=1.\n` +
    `  This creates a real "E2E Test Co" business in the target at ${SUPABASE_URL}.\n` +
    `  Point it at a LOCAL stack or a DEDICATED test project — never production —\n` +
    `  then set SEED_ALLOW=1 (add it to e2e/.env, or prefix the command).`,
  );
  process.exit(2);
}

function req(name) {
  const v = process.env[name];
  if (!v) { console.error(`✗ ${name} is required (service-role key creates the auth user).`); process.exit(2); }
  return v;
}

async function jsonOrText(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

// Wrap fetch so a connection failure says WHICH endpoint died (the built-in
// "fetch failed" hides that — usually it means the API isn't running).
async function http(label, url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    throw new Error(`could not reach ${label} at ${url} — is it running? (${e.message})`);
  }
}

// 1. Create the GoTrue auth user (idempotent: tolerate "already registered").
async function createAuthUser() {
  const r = await http('GoTrue admin', `${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, email_confirm: true }),
  });
  if (r.ok) { console.log(`✓ auth user created: ${OWNER_EMAIL}`); return; }
  const body = await jsonOrText(r);
  const msg = JSON.stringify(body);
  if (r.status === 403 || /not_admin|not allowed/i.test(msg)) {
    throw new Error(
      `GoTrue rejected the admin call (403 not_admin). SUPABASE_SERVICE_ROLE_KEY is not a ` +
      `service-role key — it is almost certainly the anon/publishable key. Use the SECRET ` +
      `service_role key (Supabase → Project Settings → API → service_role, or sb_secret_…). ` +
      `Keep it out of the repo and out of chat.`,
    );
  }
  if (r.status === 422 || /already.*registered|exists/i.test(msg)) {
    console.log(`• auth user already exists: ${OWNER_EMAIL} — continuing`); return;
  }
  throw new Error(`create auth user failed (${r.status}): ${msg}`);
}

// 2. Password grant → a GoTrue access token to authorise onboarding.
async function getToken() {
  const r = await http('GoTrue token', `${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  const body = await jsonOrText(r);
  if (!r.ok || !body.access_token) throw new Error(`password grant failed (${r.status}): ${JSON.stringify(body)}`);
  return body.access_token;
}

// 3. Onboard: create business + branch + roles + owner row (the real route).
async function onboard(token) {
  const r = await http('the API (onboarding)', `${API_BASE_URL}/api/onboarding`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: 'E2E Test Co',
      businessType: 'restaurant',
      ownerName:    'E2E Owner',
      currency:     'KES',
      vatRate:      16,
      branchName:   'Main Branch',
      ownerEmail:   OWNER_EMAIL,
      mustChangePassword: false,   // so the owner can log in straight away
    }),
  });
  if (r.ok) { console.log('✓ onboarding complete: business, branch, roles, owner'); return; }
  const body = await jsonOrText(r);
  const msg = JSON.stringify(body);
  // Already onboarded for this auth user — fine for a re-run.
  if (r.status === 409 || /already|exists|duplicate/i.test(msg)) {
    console.log(`• business already onboarded for ${OWNER_EMAIL} — continuing`); return;
  }
  throw new Error(`onboarding failed (${r.status}): ${msg}`);
}

// Persist OWNER_EMAIL/PASSWORD into e2e/.env so seed:users + the specs pick them up
// (mirrors how seed:users writes staff PINs).
function upsertEnv(pairs) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  for (const [k, v] of Object.entries(pairs)) {
    const line = `${k}=${v}`;
    text = new RegExp(`^${k}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${k}=.*$`, 'm'), line)
      : (text.endsWith('\n') || text === '' ? text + line + '\n' : text + '\n' + line + '\n');
  }
  writeFileSync(ENV_FILE, text);
}

async function run() {
  console.log(`Seeding business+owner against API ${API_BASE_URL} (auth: ${SUPABASE_URL})`);
  await createAuthUser();
  const token = await getToken();
  await onboard(token);
  upsertEnv({ OWNER_EMAIL, OWNER_PASSWORD });
  console.log(`\n✓ done. Owner credentials written to e2e/.env:`);
  console.log(`    OWNER_EMAIL=${OWNER_EMAIL}`);
  console.log(`    OWNER_PASSWORD=${OWNER_PASSWORD}`);
  console.log(`\nNext: npm run seed:users  (staff PINs), then npm test.`);
}

run().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
