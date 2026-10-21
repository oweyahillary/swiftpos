// A507 — the owner's answers of 2026-10-16:
//   1. "I will go with your recommendation": a technician may ask a server by its address INSIDE Find my server, only when
//      the network hid it — it saves nothing, the server still presses Allow (install:requestJoin, as a found server).
//   2. "an agent should be able to change but the admin should be notified of the change for verification": an agent's
//      change of a client's VAT / currency / type / KRA PIN, a new client, a cancelled mode switch — every super admin
//      is e-mailed; a super admin's own change sends nothing.
//   3. "keep it but send an email after the failed attempt": the per-account sign-in pause stays; the account is e-mailed
//      when it starts — only an address that belongs to a ZapTill account.
//   A514 (owner, 2026-10-16: "can it read the region"): the e-mail's time is the business's local time — its currency
//      names the zone (zoneForCurrency); "East Africa time" only for the EAT zones, otherwise the zone's city.
//
//   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/a507-owner-answers.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET ??= 'test-only-secret-test-only-secret';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const tick = () => new Promise((r) => setTimeout(r, 30));

// The database and the mailer, faked under the compiled libs.
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mailer = require(path.join(DIST, 'lib/mailer.js'));
let rows = { users: [], admin_users: [], businesses: [] };
const sent = [];
supabase.from = (table) => {
  const filters = [];
  const q = {
    select: () => q, limit: () => q,
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    ilike: (c, v) => { filters.push((r) => String(r[c] ?? '').toLowerCase() === String(v).toLowerCase()); return q; },
    then: (res) => res({ data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
  };
  return q;
};
mailer.sendEmailChecked = async (m) => { sent.push(m); return { ok: true, provider: 'none' }; };
const { notifyAccountLocked, zoneForCurrency, zoneLabel, localTime } = require(path.join(DIST, 'lib/accountLockNotice.js'));
const { notifySuperAdminsToVerify } = require(path.join(DIST, 'lib/adminVerifyNotice.js'));
const { noteAccountFailure, ACCOUNT_MAX_FAILS } = require(path.join(DIST, 'lib/pinAttempts.js'));

console.log('\nA507 — the owner\'s answers\n');

await ok('3. the sign-in pause starts on the 10th wrong attempt (noteAccountFailure says so once)', async () => {
  const seen = [];
  for (let i = 0; i < ACCOUNT_MAX_FAILS; i++) seen.push(noteAccountFailure('who@shop.test', 1_000 + i));
  assert.deepEqual(seen.map(Boolean), [...Array(ACCOUNT_MAX_FAILS - 1).fill(false), true]);
});
await ok('3. a ZapTill account is e-mailed when its sign-in is paused (when, from where, what to do)', async () => {
  rows = { users: [{ id: 'u1', name: 'Wanjiru', email: 'Owner@Shop.test' }], admin_users: [] }; sent.length = 0;
  notifyAccountLocked('owner@shop.test', '41.90.1.2', 'the web dashboard'); await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@shop.test');
  assert.match(sent[0].html, /paused for\s+15 minutes/); assert.match(sent[0].html, /41\.90\.1\.2/); assert.match(sent[0].html, /If it was not you/);
});
await ok('A514: zoneForCurrency — each currency its zone, CDF Kinshasa, EUR / USD UTC, unknown or none Nairobi', () => {
  const want = { KES: 'Africa/Nairobi', UGX: 'Africa/Kampala', TZS: 'Africa/Dar_es_Salaam', RWF: 'Africa/Kigali', BIF: 'Africa/Bujumbura',
    ETB: 'Africa/Addis_Ababa', SSP: 'Africa/Juba', SOS: 'Africa/Mogadishu', CDF: 'Africa/Kinshasa', NGN: 'Africa/Lagos', GHS: 'Africa/Accra',
    ZAR: 'Africa/Johannesburg', ZMW: 'Africa/Lusaka', MWK: 'Africa/Blantyre', MZN: 'Africa/Maputo', ZWL: 'Africa/Harare', ZWG: 'Africa/Harare',
    EGP: 'Africa/Cairo', MAD: 'Africa/Casablanca', XOF: 'Africa/Dakar', XAF: 'Africa/Douala', AED: 'Asia/Dubai', INR: 'Asia/Kolkata',
    GBP: 'Europe/London', EUR: 'UTC', USD: 'UTC' };
  for (const [c, z] of Object.entries(want)) {
    assert.equal(zoneForCurrency(c), z, c);
    assert.equal(zoneForCurrency(` ${c.toLowerCase()} `), z, `${c} (case and spaces)`);
    assert.doesNotThrow(() => localTime(new Date(), z), z);   // a zone this Node knows
  }
  for (const c of [null, undefined, '', 'XYZ', 42]) assert.equal(zoneForCurrency(c), 'Africa/Nairobi', String(c));
});
await ok('A514: the zone is named — East Africa time for the EAT zones, otherwise its city', () => {
  for (const z of ['Africa/Nairobi', 'Africa/Kampala', 'Africa/Dar_es_Salaam', 'Africa/Addis_Ababa', 'Africa/Mogadishu']) assert.equal(zoneLabel(z), 'East Africa time', z);
  assert.equal(zoneLabel('Africa/Kigali'), 'Kigali time');
  assert.equal(zoneLabel('Africa/Dar_es_Salaam'), 'East Africa time');
  assert.equal(zoneLabel('Africa/Addis_Ababa'), 'East Africa time');
  assert.equal(zoneLabel('Europe/London'), 'London time');
  assert.equal(zoneLabel('UTC'), 'UTC');
  // The clock is the zone's: 12:00 UTC is 14:00 in Kigali (UTC+2) and 15:00 in Nairobi (UTC+3).
  const noon = new Date('2026-10-16T12:00:00Z');
  assert.match(localTime(noon, 'Africa/Kigali'), /14:00/);
  assert.match(localTime(noon, 'Africa/Nairobi'), /15:00/);
});
await ok('A514: the e-mail reads the account\'s business — a Rwandan business is told the time in Kigali time', async () => {
  rows = { users: [{ id: 'u2', name: 'Aline', email: 'aline@shop.test', business_id: 'b-rw' }], admin_users: [],
    businesses: [{ id: 'b-rw', currency: 'RWF' }, { id: 'b-ke', currency: 'KES' }] }; sent.length = 0;
  notifyAccountLocked('aline@shop.test', null, 'the web POS'); await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /, Kigali time\)/);
  assert.doesNotMatch(sent[0].html, /East Africa time/);
  rows.users[0].business_id = 'b-ke'; sent.length = 0;
  notifyAccountLocked('aline@shop.test', null, 'the web POS'); await tick();
  assert.match(sent[0].html, /, East Africa time\)/);
  rows.users[0].business_id = null; sent.length = 0;   // no business found: Nairobi, as before
  notifyAccountLocked('aline@shop.test', null, 'the web POS'); await tick();
  assert.match(sent[0].html, /, East Africa time\)/);
});
await ok('3. …never a stranger: an address with no ZapTill account gets nothing', async () => {
  rows = { users: [], admin_users: [], businesses: [] }; sent.length = 0;
  notifyAccountLocked('victim@elsewhere.test', '1.2.3.4', 'the web dashboard'); await tick();
  assert.equal(sent.length, 0);
});
await ok('3. both sign-in paths (dashboard password, web POS PIN) send it when the pause starts', () => {
  const a = read('apps/server/src/routes/auth.ts');
  assert.match(a, /if \(noteAccountFailure\(email\)\) notifyAccountLocked\(email, req\.ip, 'the web dashboard'\)/);
  assert.match(a, /if \(noteAccountFailure\(email\)\) notifyAccountLocked\(email, req\.ip, 'the web POS'\)/);
});

await ok('2. an agent\'s change is e-mailed to every ACTIVE super admin, with before and after', async () => {
  rows = { users: [], admin_users: [
    { email: 'boss@zaptill.test', role: 'super_admin', is_active: true },
    { email: 'old@zaptill.test', role: 'super_admin', is_active: false },
    { email: 'agent@zaptill.test', role: 'agent', is_active: true },
  ] }; sent.length = 0;
  notifySuperAdminsToVerify({ who: 'agent@zaptill.test', role: 'agent', what: 'Changed tax / money settings', client: 'Pollo',
    changes: [{ field: 'VAT rate %', before: 16, after: 8 }] }); await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'boss@zaptill.test');
  assert.match(sent[0].html, /agent@zaptill\.test/); assert.match(sent[0].html, /Pollo/); assert.match(sent[0].html, />16<.*>8</s);
});
await ok('2. a super admin\'s own change sends nothing', async () => {
  sent.length = 0;
  notifySuperAdminsToVerify({ who: 'boss@zaptill.test', role: 'super_admin', what: 'x', changes: [] }); await tick();
  assert.equal(sent.length, 0);
});
await ok('2. the routes: tax fields any admin\'s, notices on edit / create / mode-switch cancel, no secret column in the edit answer', () => {
  const a = read('apps/server/src/routes/admin.ts');
  assert.doesNotMatch(a, /Only a super admin can change \$\{taxFields/);
  assert.match(a, /what: 'Changed tax \/ money settings'/);
  assert.match(a, /what: 'Created a client'/);
  assert.match(a, /what: 'Cancelled a mode switch'/);
  // A518: the answer may also name the built-in roles a type change added (roles_added — Fuel attendant at a petrol station).
  assert.ok(a.includes('res.json({ ...stripSecretColumns(data ?? {}),'), 'the edit answer strips the secret columns');
  assert.match(a, /router\.post\('\/mode-switch\/:id\/cancel', requireAdmin, async/);
  const p = read('apps/admin/src/AdminPortal.tsx');
  assert.doesNotMatch(p, /value=\{editForm\.(type|currency)\} disabled=\{!isSuper\}/);
});

await ok('1. Find my server: an address may be asked ONLY when nothing was found, and it goes through the same join', () => {
  const ask = read('apps/desktop/src/renderer/components/ServerAddressAsk.tsx');
  assert.match(ask, /onAsk\(\{ url: `http:\/\/\$\{ipT\}:\$\{portN\}`/);
  assert.match(ask, /LAN\.test\(ipT\)/);   // the shop network only
  const tech = read('apps/desktop/src/renderer/components/TechFindServer.tsx');
  assert.match(tech, /servers && servers\.length === 0 && !joinTarget && <ServerAddressAsk onAsk=\{ask\}/);
  const inst = read('apps/desktop/src/renderer/pages/InstallPage.tsx');
  assert.match(inst, /servers\.length === 0 && !joinTarget[\s\S]{0,400}<ServerAddressAsk onAsk=\{askToJoin\} \/>/);
  assert.doesNotMatch(inst, /if \(list\.length === 0\) setStep\('connection'\)/);
  // Still never saved by hand: config:save drops a typed address for a till (A502).
  assert.match(ipcHandlersSource(), /A502: refused a typed branch server address/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
