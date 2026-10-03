/**
 * support-help.test.mjs — 0.6.35 (A384): "What to do when" (till, A4 card, web) and who to call — the shop's own tech.
 *
 * Owner, 2026-10-03: approved the Help text; "add the number 0717675635 or 0782972023. Also add the feature in admin where
 * i can allocate a tech to a shop and the number appears instead of a fixed number". The shared rules run for real;
 * source pins on the cloud (Express + Supabase), the admin portal, the till's screens and the web. The till's storage and
 * relay run for real in apps/desktop/test/support-help.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: cleanPhone accepting 9 digits → "a number we cannot dial is refused" fails; supportContact
 * keeping a tech with no number → "a tech with no number shows SwiftPOS support" fails; pos/init not sending support →
 * its pin fails; the PIN pad without Help → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const S = await import(pathToFileURL(path.join(ROOT, 'shared/support.ts')).href);
const H = await import(pathToFileURL(path.join(ROOT, 'shared/helpTopics.ts')).href);

await ok('SwiftPOS support: the owner\'s two numbers', () => {
  assert.deepStrictEqual([...S.DEFAULT_SUPPORT_PHONES], ['0717675635', '0782972023']);
  const c = S.supportContact(null);
  assert.strictEqual(c.assigned, false);
  assert.deepStrictEqual(c.phones, ['0717675635', '0782972023']);
});
await ok('a number is cleaned to 07…/01…; one we cannot dial is refused; empty = none', () => {
  assert.strictEqual(S.cleanPhone('+254 712 345 678'), '0712345678');
  assert.strictEqual(S.cleanPhone('254112345678'), '0112345678');
  assert.strictEqual(S.cleanPhone('0712-345-678'), '0712345678');
  assert.strictEqual(S.cleanPhone(''), null);
  assert.strictEqual(S.cleanPhone(null), null);
  for (const bad of ['071234567', '0812345678', '12345', 'abc', '07123456789']) assert.strictEqual(S.cleanPhone(bad), undefined, bad);
  assert.strictEqual(S.displayPhone('0717675635'), '0717 675 635');
  assert.strictEqual(S.whatsappNumber('0717675635'), '254717675635');
});
await ok('the shop\'s tech replaces the fixed numbers; a tech with no number shows SwiftPOS support', () => {
  const t = S.supportContact({ name: 'Brian', phone: '0712345678' });
  assert.deepStrictEqual(t, { name: 'Brian', phones: ['0712345678'], assigned: true });
  assert.strictEqual(S.supportContact({ name: 'Brian', phone: null }).assigned, false);
  assert.strictEqual(S.supportContact({ name: 'Brian', phone: 'nope' }).assigned, false);
  assert.strictEqual(S.supportWire({ name: 'Brian', phone: null }), null);
  assert.deepStrictEqual(S.supportWire({ name: ' Brian ', phone: '+254712345678' }), { name: 'Brian', phone: '0712345678' });
});
await ok('the approved text: 9 topics + "Who to call" filled with the contact', () => {
  assert.deepStrictEqual(H.HELP_TOPICS.map((t) => t.id), ['internet', 'mpesa', 'printer', 'day', 'reverse', 'pin', 'power', 'cash', 'update']);
  for (const t of H.HELP_TOPICS) assert.ok(t.title && t.steps.length >= 2, t.id);
  const w = H.whoToCallSteps('SwiftPOS support', ['0717 675 635', '0782 972 023']);
  assert.match(w[0], /SwiftPOS support: 0717 675 635 or 0782 972 023 \(call or WhatsApp\)/);
  assert.match(JSON.stringify(H.HELP_TOPICS), /14 days/);
  assert.match(JSON.stringify(H.HELP_TOPICS), /owner's set time/);
});

await ok('cloud: migration 117 (tech phone, client\'s tech); pos/init and /business/support send the tech', () => {
  const m = read('migrations/117_support_tech.sql');
  assert.match(m, /ALTER TABLE public\.admin_users\s+ADD COLUMN IF NOT EXISTS phone text/);
  assert.match(m, /support_admin_id uuid REFERENCES public\.admin_users\(id\) ON DELETE SET NULL/);
  assert.match(read('apps/server/src/routes/pos.ts'), /support: await getSupportContact\(req\.businessId\)/);
  assert.match(read('apps/server/src/routes/business.ts'), /router\.get\('\/support', requireAuth/);
  const sc = read('apps/server/src/lib/supportContact.ts');
  assert.match(sc, /is_active === false\) return null/);
  assert.match(sc, /supportWire\(/);
});
await ok('admin: a tech\'s phone on Team (checked), the techs list, allocating a tech to a client', () => {
  const a = read('apps/server/src/routes/admin.ts');
  assert.match(a, /router\.get\('\/techs', requireAdmin/);
  assert.match(a, /const phone = cleanPhone\(req\.body\.phone\);/);
  assert.match(a, /updates\.support_admin_id = techId;/);
  assert.match(a, /That tech is not an active team member/);
  const p = read('apps/admin/src/AdminPortal.tsx');
  assert.match(p, /<SupportTechPicker req=\{req\} clientId=\{client\.id\}/);
  assert.match(p, /req\("PATCH", `\/clients\/\$\{clientId\}`, \{ support_admin_id: id \|\| null \}\)/);
  assert.match(p, /data-testid="team-phone"/);
});
await ok('till: Help on the PIN pad, the POS and the manager screens; offline; Print A4 card', () => {
  const app = read('apps/desktop/src/renderer/App.tsx');
  assert.match(app, /<HelpScreen businessName=/);
  assert.equal((app.match(/onHelp=\{openHelp\}/g) || []).length, 3);
  assert.match(read('apps/desktop/src/renderer/pages/PinPage.tsx'), /data-testid="pin-help"/);
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /data-testid="pos-help"/);
  assert.match(read('apps/desktop/src/renderer/pages/ManagerPage.tsx'), /data-testid="manager-help"/);
  const h = read('apps/desktop/src/renderer/components/HelpScreen.tsx');
  assert.match(h, /posApi\.pos\.help\(\)/);
  assert.match(h, /window\.print\(\)/);
  assert.match(h, /@page \{ size: A4/);
  assert.match(h, /HELP_TOPICS/);
  assert.match(read('apps/desktop/src/main/ipcHandlers.ts'), /handle\('pos:help'/);
  assert.match(read('apps/desktop/src/main/syncEngine.ts'), /setSupportContact\(c\.support\)/);
});
await ok('web: /help open to anyone, linked from sign-in, the dashboard menu and the web POS; no placeholder number', () => {
  const app = read('apps/dashboard/src/App.tsx');
  assert.match(app, /<Route path="\/help"\s+element=\{<HelpPage \/>\} \/>/);
  const hp = read('apps/dashboard/src/pages/HelpPage.tsx');
  assert.match(hp, /\/api\/business\/support/);
  assert.doesNotMatch(hp, /api\.get\(/);       // a plain fetch: never bounced to sign-in
  assert.match(hp, /window\.print\(\)/);
  assert.match(read('apps/dashboard/src/pages/LoginPage.tsx'), /data-testid="login-help"/);
  assert.doesNotMatch(read('apps/dashboard/src/pages/LoginPage.tsx'), /254700000000/);
  assert.match(read('apps/dashboard/src/components/DashboardLayout.tsx'), /data-testid="nav-help"/);
  assert.match(read('apps/dashboard/src/pages/pos/CashierScreen.tsx'), /window\.open\('\/help', '_blank'/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
