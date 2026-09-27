/**
 * web-till.test.mjs — A343 (2026-09-27): on the web, a cashier who did not open the running shift chooses — join it, or
 * start their own shift on the branch's WEB till ("<Branch> Web Till"). The opener, and a cashier who already chose, go
 * straight in. On the desktop nothing changes.
 *
 * Owner: "if cashier A has a shift running on Till 1 and logs into the web it should detect the shift and logs him in
 * directly … but if cashier b does the same they are asked to join cashier A shift or proceed to create a shift" — "on
 * desktop … they proceed to the current shift running on the till" — "this can be called branchname_web_till".
 *
 *   node tests/web-till.test.mjs          (build apps/server first — section 2 runs its dist/)
 *
 * RUNS the real rules (apps/dashboard/src/lib/posTerminal.ts ownOpenDrawer / mayEnterSilently / markJoined, the cloud's
 * webTillName) and the COMPILED GET /api/shifts/web-till behind the real auth middleware over HTTP (database in memory).
 * The two React screens are pinned by source (not run here); the live web POS is a target check (rule 16).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - mayEnterSilently lets anyone in                        → "cashier B is NOT let in silently" fails
 *   - the mount enters any current shift (no mayEnterSilently) → "…the mount asks first" fails
 *   - ownOpenDrawer ignores the web till                      → "B's own web-till shift → straight in" fails
 *   - /web-till reports a till's shift as the web till's      → "only the web:<branch> drawer" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.WEB_TILL_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, WEB_TILL_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  let pass = 0, fail = 0;
  const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

  // The browser's sessionStorage, for the web rules.
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const web = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/posTerminal.ts')).href);
  const label = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/terminalLabel.ts')).href);

  const A = 'u-A', B = 'u-B';
  const tills = [
    { device_id: 'dev-T1', terminal_code: 'T1', device_label: 'Front', open_shift: { id: 's-A', opened_at: '2026-09-27T08:00:00Z', opened_by: A, opened_by_name: 'Anne' } },
    { device_id: 'dev-T2', terminal_code: 'T2', device_label: 'Bar', open_shift: null },
  ];

  // ── 1. The web rules ──
  await ok('the name: "<Branch> Web Till" (a blank branch → "Web Till")', () => {
    assert.equal(label.webTillName('Westlands'), 'Westlands Web Till');
    assert.equal(label.webTillName('  '), 'Web Till');
  });
  await ok('cashier A (opened the Till 1 shift) signs in on the web → straight into it', () => {
    assert.equal(web.mayEnterSilently({ id: 's-A', opened_by: A }, A), true);
    const mine = web.ownOpenDrawer(tills, { name: 'Westlands Web Till', open_shift: null }, A);
    assert.equal(mine?.kind, 'till'); assert.equal(mine.till.device_id, 'dev-T1');
  });
  await ok('cashier B is NOT let in silently — B is asked (join A\'s, or own shift on the web till)', () => {
    assert.equal(web.mayEnterSilently({ id: 's-A', opened_by: A, cashier_id: A }, B), false);
    assert.equal(web.ownOpenDrawer(tills, { name: 'Westlands Web Till', open_shift: null }, B), null);
  });
  await ok('B chose to JOIN A\'s shift → next sign-in on this browser goes straight in', () => {
    web.markJoined('s-A', B);
    assert.equal(web.mayEnterSilently({ id: 's-A', opened_by: A }, B), true);
  });
  await ok('B CREATED their own shift on the web till → next sign-in goes straight into it', () => {
    const webTill = { name: 'Westlands Web Till', open_shift: { id: 's-B', opened_at: '2026-09-27T09:00:00Z', opened_by: B, opened_by_name: 'Ben' } };
    assert.deepEqual(web.ownOpenDrawer(tills, webTill, B), { kind: 'web' });
    assert.equal(web.mayEnterSilently({ id: 's-B', opened_by: B }, B), true);
  });
  await ok('two open drawers of your own → the picker decides (never a guess)', () => {
    const webTill = { name: 'W', open_shift: { id: 's-A2', opened_at: 'x', opened_by: A, opened_by_name: 'Anne' } };
    assert.equal(web.ownOpenDrawer(tills, webTill, A), null);
  });

  // ── 2. The cloud route, compiled, over HTTP ──
  const DIST = path.join(ROOT, 'apps/server/dist');
  if (!fs.existsSync(path.join(DIST, 'routes/shifts.js'))) {
    console.log('\nCannot load apps/server/dist/routes/shifts.js — build the server first:\n  cd apps/server && npm run build\n');
    process.exitCode = 1;
  } else {
    process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
    process.env.JWT_SECRET = randomBytes(24).toString('hex');
    process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
    process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
    const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
    const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
    const Bz = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
    const db = {
      branches: [{ id: BR, name: 'Westlands', business_id: Bz }],
      users: [{ id: 'u-A', name: 'Anne', business_id: Bz, status: 'active' }, { id: 'u-B', name: 'Ben', business_id: Bz, status: 'active' }],
      shifts: [
        { id: 's-A', business_id: Bz, branch_id: BR, device_id: 'dev-T1', terminal_code: 'T1', status: 'open', opened_at: '2026-09-27T08:00:00Z', opened_by: 'u-A' },
      ],
    };
    supabase.from = (table) => {
      const f = [];
      const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
      const q = {
        select() { return q; }, order() { return q; }, not() { return q; }, limit() { return q; },
        eq(k, v) { f.push([k, (x) => x === v]); return q; }, in(k, a) { f.push([k, (x) => a.includes(x)]); return q; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
        single() { const r = rows(); return Promise.resolve(r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'none' } }); },
        then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
      };
      return q;
    };
    const express = require('express'); const jwt = require('jsonwebtoken');
    const app = express(); app.use(express.json());
    app.use('/api/shifts', require(path.join(DIST, 'routes/shifts.js')).default);
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const get = async (p) => {
      const t = jwt.sign({ userId: 'u-B', businessId: Bz, branchId: BR, isOwner: false, permissionKeys: [], permissionsVersion: 0, sessionId: 's', surface: 'web' }, process.env.JWT_SECRET);
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/shifts${p}`, { headers: { Authorization: `Bearer ${t}` } });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    try {
      await ok('GET /web-till: "Westlands Web Till", no drawer open yet (Anne\'s Till 1 shift is NOT the web till\'s)', async () => {
        const r = await get(`/web-till?branch_id=${BR}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body, { name: 'Westlands Web Till', open_shift: null });
      });
      await ok('…only the web:<branch> drawer counts as the web till\'s: Ben\'s own web shift is reported, with his name', async () => {
        db.shifts.push({ id: 's-B', business_id: Bz, branch_id: BR, device_id: null, terminal_code: null, status: 'open', opened_at: '2026-09-27T09:00:00Z', opened_by: 'u-B' });
        const r = await get(`/web-till?branch_id=${BR}`);
        assert.equal(r.body.open_shift.id, 's-B'); assert.equal(r.body.open_shift.opened_by_name, 'Ben');
        assert.ok(!('opening_float' in r.body.open_shift), 'who and when only — no amounts');
      });
      await ok('another business\'s branch → 404', async () => {
        const r = await get(`/web-till?branch_id=99999999-9999-4999-8999-999999999999`);
        assert.equal(r.status, 404);
      });
      await ok('registered before /:id (else "web-till" would be read as a shift id)', () => {
        const s = read('apps/server/src/routes/shifts.ts');
        assert.ok(s.indexOf("router.get('/web-till'") < s.indexOf("router.get('/:id'"));
      });
    } finally { server.close(); }
  }

  // ── 3. The screens (source — React not run here) ──
  await ok('the web sign-in asks first: only mayEnterSilently(current, me) goes straight in; choosing marks it', () => {
    const c = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    assert.match(c, /if \(shift && mayEnterSilently\(shift as any, session\.staffId\)\) \{\s*setCurrentShift\(shift\);\s*return;\s*\}/);
    assert.match(c, /onShiftOpened=\{\(shift\) => \{ markJoined\(shift\.id, session\?\.staffId\);/);
  });
  await ok('the picker offers the web till first and spells out "join it, or start your own"', () => {
    const m = read('apps/dashboard/src/pages/pos/ShiftModal.tsx');
    assert.match(m, /<option value=\{WEB_TILL_VALUE\}>/);
    assert.match(m, /Join it, or start your own shift on <b>\{webTill\.name\}<\/b>\./);
    assert.match(m, /\{ device_id: '', terminal_code: null, device_label: webTill\.name, open_shift: webTill\.open_shift \}/);
  });
  await ok('the desktop is unchanged: another cashier on the till still proceeds into its running shift', () => {
    assert.match(read('apps/desktop/src/renderer/pages/PinPage.tsx'), /if \(j && !j\.sameCashier\) \{/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
