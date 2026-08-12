/**
 * receipt-permission.test.mjs — a manager may edit receipt text and NOTHING else.
 *
 * ── THE BUG (register A45) ──────────────────────────────────────────────────
 * A manager opens Receipt on the till, edits the branch address and phone,
 * presses Save, and is told "Your role does not allow this change." The tab is
 * listed on `isManagerRole` (ManagerPage.tsx:1083); the write demanded
 * `settings.manage` (business.ts:110). The UI promised what the cloud refused,
 * and the user found out after typing.
 *
 * ── WHY THIS IS NOT A ROUTE SWAP, AND WHY IT NEEDS A REAL TEST ──────────────
 * POST /business/settings writes ANY key through one handler — including
 * `supervisor_pin`, which it bcrypt-hashes, and ENCRYPTED_SETTING_KEYS
 * (mpesa_consumer_secret, mpesa_passkey), which it AES-encrypts. Widening the
 * route gate to admit `receipt.manage` without narrowing per key would hand a
 * manager write access to the supervisor PIN and the merchant's M-Pesa
 * credentials. The narrowing is the security boundary, so it is asserted here
 * against the REAL compiled middleware rather than a copy.
 *
 * Everything below imports from apps/server/dist. Run `npm run build` in
 * apps/server first — `run.sh` does.
 *
 *   node tests/receipt-permission.test.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let rbac;
try {
  rbac = require(resolve(ROOT, 'apps/server/dist/middleware/rbac.js'));
} catch (e) {
  console.error('\napps/server/dist is missing — run `npm run build` in apps/server.\n');
  process.exit(1);
}
const { requireAnyPermission, hasFullSettingsAccess } = rbac;

let passed = 0, failed = 0;
const ok = (name, cond, why) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (why) console.log(`         ${why}`);
  }
};

/** Drive real Express middleware with a fake req/res/next. */
function run(mw, req) {
  let nexted = false, status = null, body = null;
  const res = {
    status(c) { status = c; return this; },
    json(b) { body = b; return this; },
  };
  mw(req, res, () => { nexted = true; });
  return { allowed: nexted, status, body };
}

const asStaff = (...keys) => ({ isOwner: false, permissionKeys: keys });
const asOwner = () => ({ isOwner: true, permissionKeys: [] });

// ── 1. The route gate admits both, which is the point of the split ─────────
console.log('\n1. route gate — additive, so nobody loses access');
{
  const gate = requireAnyPermission('receipt.manage', 'settings.manage');

  ok('a manager holding only receipt.manage gets in',
     run(gate, asStaff('receipt.manage')).allowed);

  ok('someone holding only settings.manage STILL gets in',
     run(gate, asStaff('settings.manage')).allowed,
     'The split is additive. If this fails, every existing role lost access the '
     + 'moment A46 deployed, which is the outcome the design exists to avoid.');

  ok('the owner gets in with no keys at all',
     run(gate, asOwner()).allowed);

  ok('a wildcard gets in',
     run(gate, asStaff('*')).allowed);

  const denied = run(gate, asStaff('orders.create'));
  ok('a cashier is refused', !denied.allowed && denied.status === 403);

  ok('and the 403 names the NARROW key, not settings.manage',
     denied.body?.detail === 'Missing permission: receipt.manage',
     'Telling an owner to grant settings.manage to fix a 403 on a phone number '
     + 'is how one switch came to gate sixteen routes (A46).');
}

// ── 2. hasFullSettingsAccess — who escapes the allow-list ──────────────────
console.log('\n2. only full settings access escapes the allow-list');
{
  ok('settings.manage  -> full',   hasFullSettingsAccess(asStaff('settings.manage')));
  ok('wildcard         -> full',   hasFullSettingsAccess(asStaff('*')));
  ok('owner            -> full',   hasFullSettingsAccess(asOwner()));
  ok('receipt.manage   -> NOT full', !hasFullSettingsAccess(asStaff('receipt.manage')),
     'If this returns true, receipt.manage writes supervisor_pin and the M-Pesa '
     + 'credentials — the exact failure this narrowing exists to prevent.');
  ok('no keys at all   -> NOT full', !hasFullSettingsAccess(asStaff()));
  ok('undefined permissionKeys does not throw',
     hasFullSettingsAccess({ isOwner: false }) === false,
     'requireAuth may not have populated it on an unusual path; a throw here '
     + 'would be a 500 on a settings write.');
}

// ── 3. The allow-list itself, and WHERE the check sits ─────────────────────
// Source assertions, because the handler is not exported and mounting it would
// need a live Supabase client. The ordering property below is the one that
// actually matters and it is checkable exactly.
console.log('\n3. the allow-list, and the order of the checks');
{
  const raw = readFileSync(resolve(ROOT, 'apps/server/src/routes/business.ts'), 'utf8');
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

  const listed = (src.match(/RECEIPT_SETTING_KEYS = new Set\(\[([^\]]*)\]/) ?? [])[1] ?? '';
  const keys = (listed.match(/'[\w.]+'/g) ?? []).map(s => s.slice(1, -1)).sort();

  ok('the allow-list is exactly receipt_header and receipt_footer',
     JSON.stringify(keys) === JSON.stringify(['receipt_footer', 'receipt_header']),
     `found: ${JSON.stringify(keys)}. ReceiptTextTab writes exactly these two `
     + `(ipcHandlers.ts:1591-1592). Anything else here widens what a manager can `
     + `write beyond the screen that motivated it.`);

  ok('supervisor_pin is NOT in the allow-list',
     !keys.includes('supervisor_pin'));
  ok('no mpesa credential is in the allow-list',
     !keys.some(k => k.startsWith('mpesa')));

  // THE ORDERING PROPERTY. The per-key check must run before the branches that
  // write a bcrypt hash or an encrypted credential. If it drifts below them, a
  // caller holding only receipt.manage reaches code that writes supervisor_pin
  // before anyone asks whether they may.
  const guard  = src.indexOf('!hasFullSettingsAccess(req)');
  const hashed = src.indexOf('HASHED_SETTING_KEYS.has(key)');
  const encd   = src.indexOf('ENCRYPTED_SETTING_KEYS.has(key)');

  ok('the per-key guard exists', guard !== -1);
  ok('it runs BEFORE the bcrypt branch',
     guard !== -1 && hashed !== -1 && guard < hashed,
     'Below it, receipt.manage reaches the code that writes supervisor_pin_hash.');
  ok('it runs BEFORE the encrypted-credential branch',
     guard !== -1 && encd !== -1 && guard < encd,
     'Below it, receipt.manage reaches the code that writes M-Pesa secrets.');

  ok('the route no longer demands settings.manage outright',
     !/post\('\/settings',[^)]*requirePermission\('settings\.manage'\)/.test(src),
     'That is A45: the tab is offered to a manager and the write refuses them.');

  // Section 1 builds its OWN gate, so it proves requireAnyPermission is
  // additive — not that this route is wired additively. Mutation found the gap:
  // removing 'settings.manage' from the real route left all nineteen
  // assertions green while every existing role silently lost access to every
  // business setting. The route's own wiring has to be read.
  const gateCall = (src.match(/post\('\/settings',[\s\S]{0,160}?\)\s*,\s*async/) ?? [])[0] ?? '';
  ok('the ROUTE names receipt.manage',
     /'receipt\.manage'/.test(gateCall), `route gate reads: ${gateCall.slice(0, 120)}`);
  ok('the ROUTE still names settings.manage',
     /'settings\.manage'/.test(gateCall),
     'Without it, everyone holding settings.manage today loses every business '
     + 'setting the moment this deploys — the exact outcome the additive design '
     + 'exists to prevent, and it would look like a clean green.');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
