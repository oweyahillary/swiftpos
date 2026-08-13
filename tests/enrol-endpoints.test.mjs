/**
 * enrol-endpoints.test.mjs — the device-enrolment endpoints (register D4).
 *
 *   node enrol-endpoints.test.mjs
 *
 * The single-use burn itself is proven against real Postgres in
 * scripts/test-migration-81.mjs. This covers what the ENDPOINTS add on top,
 * without a server round-trip (which the bench cannot do):
 *   1. LOGIC — the code generator (readable alphabet, length, no ambiguous
 *      characters, uniqueness) and the SHA-256 hashing, copied and kept in sync.
 *   2. SOURCE GUARD — reads auth.ts and enrol.ts and asserts the redeem uses the
 *      exact atomic guard proven in the migration test (active + unexpired +
 *      business-scoped), mints a desktop-surface token, and that issue is
 *      owner-only and stores only the hash. If the guard is dropped, this fails.
 *
 * What is NOT covered here and needs a running server: the actual HTTP flow,
 * token signing/verification, and registerDesktopTerminal writing user_devices.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// ── 1. Logic (copy of enrol.ts makeCode, kept in sync by hand) ──────────────
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 10;
function makeCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const sample = Array.from({ length: 2000 }, makeCode);
ok('code is the expected length', sample.every(c => c.length === CODE_LEN));
ok('code uses only the readable alphabet', sample.every(c => [...c].every(ch => ALPHABET.includes(ch))));
ok('code contains no ambiguous characters (0 O 1 I L)',
   sample.every(c => !/[01OIL]/.test(c)));
ok('codes are effectively unique across 2000 draws',
   new Set(sample).size >= 1999);

// The redeem hashes the raw code with SHA-256; the same input must map to the
// same stored hash, and case is normalised (redeem upper-cases before hashing).
const raw = 'abcd23wxyz';
const h1 = crypto.createHash('sha256').update(raw.toUpperCase()).digest('hex');
const h2 = crypto.createHash('sha256').update('ABCD23WXYZ').digest('hex');
ok('SHA-256 of the code is stable and case-normalised', h1 === h2 && h1.length === 64);

// ── 2. Source guard — auth.ts redeem ────────────────────────────────────────
const authSrc = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/auth.ts'), 'utf8');
const redeem = (authSrc.split("router.post('/enrol/redeem'")[1] ?? '').split('router.post(')[0];

ok('redeem route exists', redeem.length > 0);
ok('redeem burns only ACTIVE codes', /\.eq\('status',\s*'active'\)/.test(redeem));
ok('redeem rejects EXPIRED codes', /\.gt\('expires_at',/.test(redeem));
ok('redeem is scoped to the business (no cross-tenant redeem)', /\.eq\('business_id',\s*businessId\)/.test(redeem));
ok('redeem flips the code to redeemed (single-use)', /status:\s*'redeemed'/.test(redeem));
ok('redeem mints a DESKTOP-surface token', /surface:\s*'desktop'/.test(redeem));
ok('redeem returns a single 401 ENROL_INVALID for any failure (no oracle)',
   /status\(401\)[\s\S]{0,120}ENROL_INVALID/.test(redeem) &&
   (redeem.match(/ENROL_INVALID/g) || []).length === 1);
ok('redeem takes the token principal from the code (created_by)', /created_by/.test(redeem));

// ── 3. Source guard — enrol.ts issue ────────────────────────────────────────
const enrolSrc = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/enrol.ts'), 'utf8');
ok('issue requires auth', /router\.use\(requireAuth\)/.test(enrolSrc));
ok('issue is owner-only', /req\.isOwner/.test(enrolSrc));
ok('issue stores the hash, never the raw code', /createHash\('sha256'\)/.test(enrolSrc) && /code_hash:\s*codeHash/.test(enrolSrc));
ok('issue sets an expiry', /expires_at:\s*expiresAt/.test(enrolSrc));
ok('issue records who created it', /created_by:\s*req\.userId/.test(enrolSrc));

// ── 4. Source guard — mounting ──────────────────────────────────────────────
const idxSrc = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/index.ts'), 'utf8');
ok('enrol router is mounted', /router\.use\('\/enrol',\s*enrolRoutes\)/.test(idxSrc));

console.log(`\n${fail === 0
  ? `All ${pass} checks passed. Enrolment issue + redeem are wired to the proven burn.`
  : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
