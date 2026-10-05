/**
 * terminal-write-guard.test.mjs — A159. A stolen till token (surface='desktop') must not WRITE dashboard data
 * (products, prices, users, settings). The till's own writes are a short allowlist; the manager screens on the till may
 * write the dashboard routes only with a person's PIN sign-in (`pinSignIn`), never with the till's device token; every
 * other desktop-surface write is denied. Ships DRY-RUN (log-only) until TERMINAL_WRITE_ENFORCE=true.
 *
 * 2026-10-02: runs the REAL rule (apps/server/src/lib/terminalWrites.ts — before, this file kept a copy of the list) and
 * reads every cloud write in the till's source (apps/desktop/src/main): each must be allowed, with the token it is sent
 * with. That is what found the gaps the enforce flip would have opened: the manager screens' ~30 writes (Menu, Staff,
 * Payment methods, Stations, Settings, Expense types) and /api/day-close/ack were all outside the till allowlist.
 *
 * MUTATIONS TO CONFIRM BITE: drop /api/orders from TILL_WRITES → "every till write is allowed" fails; let the device
 * token use MANAGER_WRITES → "the device token cannot edit the business" fails; remove a MANAGER_WRITES entry → "every
 * manager-screen write is allowed for a PIN sign-in" fails; stop setting pinSignIn at /verify-pin → its source pin fails.
 *
 *   node tests/terminal-write-guard.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

const T = await import(pathToFileURL(path.join(root, 'apps/server/src/lib/terminalWrites.ts')).href);
const denied = (surface, method, p, pin = false) => T.terminalWriteDenied(surface, method, p, pin);

// ── The device token: the till's own writes only ──────────────────────────────
for (const [m, p] of [['POST','/api/products'],['PATCH','/api/products/123'],['POST','/api/categories'],
                      ['PATCH','/api/staff/9'],['DELETE','/api/branches/2'],['POST','/api/business/settings'],
                      ['PATCH','/api/discounts/1'],['POST','/api/variants/groups']]) {
  ok(`device token: ${m} ${p} is DENIED`, () => assert.equal(denied('desktop', m, p), true));
}
for (const [m, p] of [['POST','/api/orders'],['POST','/api/orders/abc/void'],['POST','/api/orders/abc/refund'],
                      ['POST','/api/sync/push'],['POST','/api/branch-prices/sync'],['POST','/api/auth/verify-pin'],
                      ['POST','/api/tech/audit'],['POST','/api/shifts/abc/close'],['POST','/api/shifts/abc/force-close'],
                      ['POST','/api/shifts/abc/foreign-cash'],['POST','/api/shifts/abc/foreign-orders'],
                      ['POST','/api/shifts/abc/confirm'],['POST','/api/shifts/confirmer'],['POST','/api/day-close/ack'],
                      ['PUT','/api/business/branding'],['PUT','/api/stations/st-1/categories']]) {
  ok(`device token: ${m} ${p} is allowed (the till's own)`, () => assert.equal(denied('desktop', m, p), false));
}
ok('the till allowance is tight: shift delete/create, a wider /api/business, day-close other than ack — DENIED', () => {
  assert.equal(denied('desktop','DELETE','/api/shifts/abc123'), true);
  assert.equal(denied('desktop','POST','/api/shifts'), true);
  assert.equal(denied('desktop','PATCH','/api/business/'), true);
  assert.equal(denied('desktop','PUT','/api/business/branding/extra'), true);
  assert.equal(denied('desktop','POST','/api/day-close'), true);
  // A411: a station's category set only — creating, renaming, deleting a station stays a PIN sign-in's.
  assert.equal(denied('desktop','POST','/api/stations'), true);
  assert.equal(denied('desktop','PATCH','/api/stations/st-1'), true);
  assert.equal(denied('desktop','DELETE','/api/stations/st-1'), true);
  assert.equal(denied('desktop','POST','/api/stations/seed-defaults'), true);
});

// ── A person's PIN sign-in: + the manager screens' writes ─────────────────────
for (const [m, p] of [['POST','/api/products'],['PATCH','/api/products/123'],['POST','/api/products/bulk'],
                      ['POST','/api/categories'],['PATCH','/api/staff/9'],['POST','/api/business/settings'],
                      ['PUT','/api/stations/7/categories'],['DELETE','/api/variants/options/3'],['PUT','/api/combos/4/items']]) {
  ok(`PIN sign-in: ${m} ${p} is allowed (manager screens; the route checks the person's permission)`,
    () => assert.equal(denied('desktop', m, p, true), false));
}
ok('PIN sign-in: everything else stays DENIED (branches, discounts, roles, deeper paths)', () => {
  assert.equal(denied('desktop','DELETE','/api/branches/2', true), true);
  assert.equal(denied('desktop','PATCH','/api/discounts/1', true), true);
  assert.equal(denied('desktop','POST','/api/staff/roles/x/permissions', true), true);
  assert.equal(denied('desktop','POST','/api/products/1/delete-everything', true), true);
});

// ── Reads and web are never gated ─────────────────────────────────────────────
ok('reads, the web and a token without a surface are never gated', () => {
  assert.equal(denied('desktop','GET','/api/products'), false);
  assert.equal(denied('web','POST','/api/products'), false);
  assert.equal(denied(null,'POST','/api/products'), false);
});

// ── Every cloud write in the till's source is allowed, with the token it is sent with ──
// manageFetch(...) is the manager screens (a PIN sign-in's token); everything else is the till's own (device token).
// A URL written inside a fetch(...) call takes the method from that call; one built into a variable first (shift close)
// takes the next method within 30 lines.
const DIR = path.join(root, 'apps/desktop/src/main');
const writes = [];
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
  const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*)/.test(ln)) return;
    const mf = /manageFetch\(\s*([`'])(\/api\/[^`']*)\1\s*,\s*'(POST|PUT|PATCH|DELETE)'/.exec(ln);
    if (mf) { writes.push({ at: `${f}:${i + 1}`, kind: 'manager', method: mf[3], path: mf[2] }); return; }
    if (/manageFetch\(/.test(ln)) return;
    for (const m of ln.matchAll(/[`'](?:\$\{[^}]*\})?(\/api\/[^`'\s]*)[`']/g)) {
      const win = (/fetch\(/i.test(ln) ? lines.slice(i, i + 4) : lines.slice(i, i + 30)).join('\n');
      const wm = /method:\s*'(POST|PUT|PATCH|DELETE)'/.exec(win);
      if (wm) writes.push({ at: `${f}:${i + 1}`, kind: 'till', method: wm[1], path: m[1] });
    }
  });
}
const concrete = (p) => p.replace(/\$\{[^}]*\}/g, 'x').split('?')[0];
ok(`the scan finds the till's writes (${writes.filter((w) => w.kind === 'till').length} own, ${writes.filter((w) => w.kind === 'manager').length} manager-screen)`, () => {
  const paths = new Set(writes.map((w) => concrete(w.path)));
  for (const p of ['/api/orders', '/api/sync/push', '/api/shifts/x/close', '/api/shifts/x/force-close', '/api/day-close/ack',
                   '/api/orders/x/x', '/api/products', '/api/staff', '/api/business/settings']) {
    assert.ok(paths.has(p), `scan lost ${p} — the parity check below would pass for the wrong reason`);
  }
  assert.ok(!paths.has('/api/day-close/pending'), 'a GET was taken for a write');
});
ok('every till write is allowed for the device token', () => {
  const bad = writes.filter((w) => w.kind === 'till' && denied('desktop', w.method, concrete(w.path), false));
  assert.deepEqual(bad.map((w) => `${w.method} ${w.path} (${w.at})`), []);
});
ok('every manager-screen write is allowed for a PIN sign-in', () => {
  const bad = writes.filter((w) => w.kind === 'manager' && denied('desktop', w.method, concrete(w.path), true));
  assert.deepEqual(bad.map((w) => `${w.method} ${w.path} (${w.at})`), []);
});
ok('the device token cannot edit the business: every manager-screen write is DENIED to it', () => {
  const open = writes.filter((w) => w.kind === 'manager' && !denied('desktop', w.method, concrete(w.path), false));
  assert.deepEqual(open.map((w) => `${w.method} ${w.path} (${w.at})`), []);
});

// ── The wiring (source) ───────────────────────────────────────────────────────
const AUTH = read('apps/server/src/middleware/auth.ts');
const ROUTES = read('apps/server/src/routes/auth.ts');
ok('the guard runs in requireAuth with the real rule and the token kind', () => {
  assert.match(AUTH, /terminalWriteBlocked\(req, res\)/);
  assert.match(AUTH, /import \{ terminalWriteDenied \} from '\.\.\/lib\/terminalWrites';/);
  assert.match(AUTH, /terminalWriteDenied\(req\.surface, req\.method, path, req\.pinSignIn === true\)/);
  assert.match(AUTH, /req\.pinSignIn\s+= \(payload as \{ pinSignIn\?: unknown \}\)\.pinSignIn === true;/);
  assert.ok(!/TILL_WRITE_ALLOWLIST/.test(AUTH), 'a second copy of the list is back in the middleware');
});
ok('a PIN sign-in on a till carries pinSignIn (and refresh keeps the payload)', () => {
  assert.match(ROUTES, /\.\.\.\(req\.surface === 'desktop' \? \{ pinSignIn: true \} : \{\}\),/);
  assert.match(ROUTES, /const \{ tokenType, iat, exp, jti, \.\.\.cleanPayload \} = payload;/);
});
ok('dry-run is the default (enforce is opt-in via env)', () => {
  assert.match(AUTH, /String\(process\.env\.TERMINAL_WRITE_ENFORCE \|\| ''\)\.toLowerCase\(\) === 'true'/);
});

console.log(`\n${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'A159 terminal write guard');
