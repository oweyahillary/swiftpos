// A586 (2026-10-23) — the product says "POS" or "point of sale", never "till".
//
// Owner: "ensure we use the word POS or point of sale instead of till". The website already did; this proves the product:
//   G. the gate (scripts/check-no-till-wording.mjs) passes on the repo, and catches a "till" put back into a real screen,
//      a server message and a printed line — while M-Pesa's own "Till number", identifiers, comments and logs pass;
//   P. the frozen permission catalogue and built-in roles (packages/core/src/permissions.ts — migrations 134 and 142 register them
//      word for word) read POS through posWording(), for every business type, and M-Pesa's "Buy Goods till number" stays;
//   S. a few key screens and messages say POS (technician console, admin portal, sidebar, PIN page, the cloud's errors,
//      the owner's email);
//   R. the printed Z-report's web-shift line says POS at 58 and 80 mm, inside the paper width.
//
//   node tests/pos-wording-a586.test.mjs
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-23):
//   - "Rejoin this POS" back to "Rejoin this till" in TechPage.tsx            → G "the repo passes the gate" and S fail
//   - posWording() returning its input                                         → P fails
//   - the shift report's "+ Web shift, this POS" back to "this till"           → G and R fail
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, fn) => {
  try { await fn(); console.log(`PASS  ${n}`); pass++; } catch (e) { console.log(`FAIL  ${n}  ${e?.message ?? e}`); fail++; }
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TILL = /(?<![\w$@\-/.])(till|tills)(?![\w\-/])/i;

const G = await import(pathToFileURL(path.join(ROOT, 'scripts/check-no-till-wording.mjs')).href);

console.log('\nG. the gate\n');
await ok('the repo passes the gate (no user-visible "till" in any app, the cloud, the help or the printing)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-no-till-wording.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
await ok('its self-test passes', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-no-till-wording.mjs'), '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
await ok('"till" put back into real files is caught: a desktop screen, a cloud error, a printed line', () => {
  for (const [rel, from, to] of [
    ['apps/desktop/src/renderer/pages/TechPage.tsx', 'Rejoin this POS', 'Rejoin this till'],
    ['apps/server/src/routes/auth.ts', 'This POS is no longer joined to the business.', 'This till is no longer joined to the business.'],
    ['shared/printing/src/shiftReport.ts', '+ Web shift, this POS', '+ Web shift, this till'],
    ['apps/admin/src/AdminPortal.tsx', 'Branches & POS', 'Branches & tills'],
  ]) {
    const src = read(rel);
    assert.ok(src.includes(from), `${rel} says "${from}"`);
    assert.equal(G.scanSource(rel, src).length, 0, `${rel} is clean`);
    assert.ok(G.scanSource(rel, src.replace(from, to)).length >= 1, `${rel}: "${to}" is caught`);
  }
});
await ok('kept: M-Pesa\'s Till number, identifiers, comments, developer logs, SQL', () => {
  assert.equal(G.scanSource('apps/x/src/a.tsx', [
    "const a = 'Customers choose Buy Goods and enter the Buy Goods till number';",
    "const r = `TILL NO: ${no}`;",
    "const t = row.till; const k = 'tills'; db.from('till_sessions'); // the till signs in",
    "logLine('sync', 'this till could not reach the cloud');",
    "db.prepare(`SELECT * FROM tills WHERE device_role = 'till'`);",
  ].join('\n')).length, 0);
  // the whole M-Pesa helper (every copy) is M-Pesa's own words
  assert.equal(G.scanSource('packages/core/src/mpesaReceive.ts', read('packages/core/src/mpesaReceive.ts')).length, 0);
});

console.log('\nP. the frozen catalogue, read through posWording\n');
const T = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/businessTerms.ts')).href);
const PM = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/permissions.ts')).href);
const stripMpesa = (s) => s.replace(/buy[\s-]*goods(?:\s*till)?(?:\s*(?:no\.?|numbers?))?/gi, '');
await ok('posWording: labels, sentences, plurals, the desktop POS beside the web POS, M-Pesa kept', () => {
  const cases = [
    ['Tills and devices', 'POS and devices'],
    ['Approve till changes', 'Approve POS changes'],
    ['Sells at the till', 'Sells at the POS'],
    ['At the till and the web POS', 'At the desktop POS and the web POS'],
    ['How the business, its branches and its tills are set up', 'How the business, its branches and its points of sale are set up'],
    ['Branches & tills', 'Branches & POS'],
    ['Tills keep selling.', 'Points of sale keep selling.'],
    ['Till: T1', 'POS: T1'],
    ["This till's sign-in", "This POS's sign-in"],
    ['(Buy Goods till number, or Paybill), set on the till', '(Buy Goods till number, or Paybill), set on the POS'],
    ['TILL NO: 123456', 'TILL NO: 123456'],
    ['No change here', 'No change here'],
  ];
  for (const [from, want] of cases) assert.equal(T.posWording(from), want, from);
});
await ok('every catalogue label and description, every group and every built-in role reads no "till" — for every business type', () => {
  const types = [...T.BUSINESS_TYPE_KEYS, null];
  let seen = 0;
  for (const type of types) {
    for (const p of PM.PERMISSIONS) {
      const w = T.permissionWords(type, p.key, p.label, p.description);
      assert.ok(!TILL.test(stripMpesa(w.label)) && !TILL.test(stripMpesa(w.description)), `${type} ${p.key}: ${w.label} — ${w.description}`);
      if (TILL.test(stripMpesa(p.label + ' ' + p.description))) seen++;
    }
    for (const g of PM.PERMISSION_GROUPS) {
      const w = T.permissionGroupWords(type, g.id, g.label, g.description);
      assert.ok(!TILL.test(w.label) && !TILL.test(w.description), `${type} group ${g.id}: ${w.description}`);
    }
  }
  assert.ok(seen > 0, 'the frozen catalogue still says "till" (so this test is about something)');
  for (const r of PM.BUILT_IN_ROLES) assert.ok(!TILL.test(T.posWording(r.description ?? '')), r.name);
  // and the catalogue itself is untouched (migration 134 / 142 register it word for word)
  assert.ok(PM.PERMISSIONS.some((p) => p.label === 'Tills and devices'), 'catalogue unchanged');
});
await ok('the screens that show them translate: the roles picker and the roles list', () => {
  assert.match(read('apps/dashboard/src/components/PermissionPicker.tsx'), /permissionWords\(businessType, k\.key, k\.label, k\.description\)/);
  assert.match(read('apps/dashboard/src/pages/settings/RolesTab.tsx'), /posWording\(r\.description\)/);
  assert.match(read('apps/dashboard/src/components/PermissionPicker.tsx'), /\['Web', 'POS'\]/);
});

console.log('\nS. key screens and messages\n');
await ok('desktop: technician console, PIN page, lock, manager', () => {
  assert.match(read('apps/desktop/src/renderer/pages/TechPage.tsx'), /Rejoin this POS/);
  assert.match(read('apps/desktop/src/renderer/pages/PinPage.tsx'), /This POS/);
  assert.match(read('apps/desktop/src/renderer/components/LockCurtain.tsx'), /POS locked/);
  assert.match(read('apps/desktop/src/renderer/pages/ManagerPage.tsx'), /Lock POS/);
});
await ok('admin portal and web dashboard: Branches & POS, Enrol POS, POS & days', () => {
  const admin = read('apps/admin/src/AdminPortal.tsx');
  assert.match(admin, /Branches & POS/); assert.match(admin, /Enrol POS/); assert.match(admin, /POS & days/);
  assert.match(read('apps/dashboard/src/components/DashboardLayout.tsx'), /POS & Days/);
});
await ok('the cloud: refusals and the owner\'s email say POS', () => {
  assert.match(read('apps/server/src/routes/auth.ts'), /This POS is no longer joined to the business\. A technician can rejoin it\./);
  const mail = read('apps/server/src/jobs/ownerEmails.ts');
  assert.match(mail, /POS not syncing/); assert.match(mail, /Rejoin this POS/); assert.ok(!/Branches &amp; tills/.test(mail));
});
await ok('a branch server on 1.0.20 says POS, and a till on 1.0.20 still reads an older server\'s "till" refusal', () => {
  const gw = read('apps/desktop/src/main/cloudGateway.ts');
  assert.match(gw, /Update this \(till\|POS\)\|two different \(tills\|points of sale\)/);
  const re = /device key|not joined|Update this (till|POS)|two different (tills|points of sale)/i;
  for (const said of ['Update this till — the branch server answers this only to tills with a device key.', 'the request names two different tills',
    'Update this POS to hand changes to the branch server.', 'the request names two different points of sale (check the device key)']) assert.ok(re.test(said), said);
  assert.match(read('apps/desktop/src/main/nodeServer.ts'), /two different points of sale \(check the device key\)/);
});

console.log('\nR. the printed Z-report\n');
const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);
const base = {
  businessName: 'B Foods', currencyCode: 'KES', cashierName: 'Mary', shiftRef: '6425f8ed',
  openedAt: new Date('2026-10-23T06:55:40Z'), closedAt: new Date('2026-10-23T15:00:00Z'), status: 'closed',
  byMethod: [{ method: 'cash', orders: 1, amount: 139000 }], orderCount: 1, grossSales: 139000, voidCount: 0,
  openingFloat: 300000, cashSales: 139000, floatIn: 0, floatOut: 0, siblingCash: 25000, expectedCash: 464000,
  countedCash: 464000, variance: 0, printedAt: new Date('2026-10-23T15:00:05Z'),
};
await ok('"+ Web shift, this POS" on the paper at 58 and 80 mm, inside the width; no "till" anywhere on it', () => {
  for (const [mm, cols] of [[58, 32], [80, 48]]) {
    const text = Buffer.from(E.renderShiftReportEscPos(base, mm)).toString('latin1');
    const line = text.split(/[\n\r]/).find((l) => l.includes('+ Web shift, this POS'));
    assert.ok(line, `${mm} mm has the line`);
    // eslint-disable-next-line no-control-regex
    const visible = line.replace(/[\x00-\x1f]|\x1b.|\x1d../g, '').replace(/^[!E\-a]\x00?/, '');
    assert.ok(visible.trimEnd().length <= cols, `${mm} mm: "${visible}" fits ${cols} columns`);
    assert.ok(!TILL.test(text), `${mm} mm: no till on the slip`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
