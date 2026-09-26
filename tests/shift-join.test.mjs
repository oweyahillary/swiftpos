/**
 * shift-join.test.mjs — A273 follow-up (2026-09-26): the web POS joins an OPEN till drawer instead of
 * asking for a float, and joins the cashier's OWN open till without asking anything.
 *
 * Owner: "if i open a shift on desktop pos and i log into web pos it should prompt me to select a till …
 * if i am using the email used to open any of the till it should not ask me all this". And on 2026-09-15
 * (target): the picker "still asks for an opening float even when the till already has an open drawer".
 *
 *   node tests/shift-join.test.mjs
 *
 * RUNS the real rules: the cloud's openDrawersByTill (lib/tillShifts.ts) and the web's withOpenShifts,
 * loadTills, ownOpenTill and openShiftLine (lib/posTerminal.ts). The route, the modal and the mount check
 * are pinned by source (Express/React not run here); the live two-surface run is a target check (rule 16).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - ownOpenTill joins when TWO tills are the cashier's                → "two of mine → the picker" fails
 *   - ownOpenTill ignores who opened it                                  → "someone else's drawer is never joined silently" fails
 *   - handleOpen no longer joins an open till (asks the float again)     → "an open till is joined — never a float" fails
 *   - the mount check stops trying the cashier's own till                → "sign-in joins the cashier's own open till" fails
 *   - the route drops the branch scope                                   → "scoped to the caller's business AND branch" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.SHIFT_JOIN_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, SHIFT_JOIN_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  let pass = 0, fail = 0;
  const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
  const cloud = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/tillShifts.ts')).href);
  const web = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/posTerminal.ts')).href);

  // ── The cloud's answer ──
  const shifts = [
    { id: 's-old', device_id: 'dev-1', opened_at: '2026-09-26T06:00:00Z', opened_by: 'u-jane' },
    { id: 's-new', device_id: 'dev-1', opened_at: '2026-09-26T09:02:00Z', opened_by: 'u-jane' },
    { id: 's-2',   device_id: 'dev-2', opened_at: '2026-09-26T08:00:00Z', opened_by: null, cashier_id: 'u-tom' },
  ];
  const names = { 'u-jane': 'Jane', 'u-tom': 'Tom' };
  const drawers = cloud.openDrawersByTill(shifts, names);
  await ok('one drawer per till — the NEWEST (the one /current returns)', () => {
    assert.equal(drawers.length, 2);
    assert.equal(drawers.find((d) => d.device_id === 'dev-1').open_shift.id, 's-new');
  });
  await ok('who opened it: opened_by, else cashier_id — with the name', () => {
    assert.deepEqual(drawers.find((d) => d.device_id === 'dev-2').open_shift, { id: 's-2', opened_at: '2026-09-26T08:00:00Z', opened_by: 'u-tom', opened_by_name: 'Tom' });
  });
  await ok('who and when only — no amount leaves the cloud', () => {
    for (const d of drawers) assert.deepEqual(Object.keys(d.open_shift).sort(), ['id', 'opened_at', 'opened_by', 'opened_by_name']);
  });

  // ── The web's reading of it ──
  const tills = [
    { device_id: 'dev-1', terminal_code: 'T1', device_label: 'Front Counter' },
    { device_id: 'dev-2', terminal_code: 'T2', device_label: 'Bar' },
    { device_id: 'dev-3', terminal_code: 'T3', device_label: 'Patio' },
  ];
  const merged = web.withOpenShifts(tills, drawers);
  await ok('merge by device_id: open tills carry their drawer, the rest are closed', () => {
    assert.equal(merged[0].open_shift.id, 's-new'); assert.equal(merged[2].open_shift, null);
  });
  await ok('sign-in: exactly one open drawer is mine → joined silently', () => {
    assert.equal(web.ownOpenTill(merged, 'u-jane')?.device_id, 'dev-1');
  });
  await ok('someone else\'s drawer is never joined silently; no user → nothing', () => {
    assert.equal(web.ownOpenTill(merged, 'u-sam'), null); assert.equal(web.ownOpenTill(merged, null), null);
    // ONE open till, opened by Jane — Sam signing in must still get the picker, not Jane's drawer.
    const onlyJane = web.withOpenShifts(tills, cloud.openDrawersByTill([shifts[1]], names));
    assert.equal(web.ownOpenTill(onlyJane, 'u-sam'), null);
  });
  await ok('two of mine → the picker (never a guess about whose cash)', () => {
    const two = web.withOpenShifts(tills, cloud.openDrawersByTill([...shifts, { id: 's-3', device_id: 'dev-3', opened_at: '2026-09-26T07:00:00Z', opened_by: 'u-jane' }], names));
    assert.equal(web.ownOpenTill(two, 'u-jane'), null);
  });
  await ok('the picker line: "open — Jane, since HH:MM"', () => {
    assert.match(web.openShiftLine(merged[0]), /^open — Jane, since \d\d:\d\d$/);
    assert.equal(web.openShiftLine(merged[2]), '');
    assert.match(web.openShiftLine({ ...merged[0], open_shift: { ...merged[0].open_shift, opened_by_name: null } }), /^open — another cashier/);
  });
  await ok('loadTills: both lists merged; an older cloud without /terminals/open → all closed, not an error', async () => {
    const good = await web.loadTills(async (p) => (p.includes('/open') ? drawers : tills), 'b-1');
    assert.equal(good[0].open_shift.id, 's-new');
    const old = await web.loadTills(async (p) => { if (p.includes('/open')) throw new Error('404'); return tills; }, 'b-1');
    assert.ok(old.every((t) => t.open_shift === null));
  });

  // ── Wiring (source — Express / React not run here) ──
  await ok('the route is scoped to the caller\'s business AND branch, open shifts only, and returns openDrawersByTill', () => {
    const s = read('apps/server/src/routes/shifts.ts');
    const h = s.slice(s.indexOf("router.get('/terminals/open'"), s.indexOf("router.get('/terminals/open'") + 1400);
    assert.match(h, /\.eq\('business_id', req\.businessId\)/); assert.match(h, /\.eq\('branch_id', branchId\)/);
    assert.match(h, /\.eq\('status', 'open'\)/); assert.match(h, /res\.json\(openDrawersByTill\(open, nameById\)\)/);
    assert.doesNotMatch(h.slice(0, h.indexOf('res.json(openDrawersByTill')), /opening_float|expected|closing_float/);
    assert.ok(s.indexOf("router.get('/terminals/open'") < s.indexOf("router.get('/:id'"), 'must be registered before /:id');
  });
  await ok('an open till is joined — never a float: handleOpen joins BEFORE reading the float; the float field is hidden', () => {
    const m = read('apps/dashboard/src/pages/pos/ShiftModal.tsx');
    const h = m.slice(m.indexOf('const handleOpen = async'));
    assert.ok(h.indexOf('if (till.open_shift) { await handleJoin(till); return; }') > -1 &&
      h.indexOf('if (till.open_shift) { await handleJoin(till); return; }') < h.indexOf('parseFloat(openFloat)'));
    assert.match(m, /\{!joining && \(<>\s*<label style=\{s\.label\}>Opening Float/);
    assert.match(m, /const handleJoin = async \(till: CoveredTerminal\) => \{[\s\S]{0,200}setCoveredTerminal\(till\);[\s\S]{0,120}\/api\/shifts\/current/);
    assert.match(m, /loadOpenDrawers\(\(path\) => posApi\.get\(path\), branchId\)[\s\S]{0,120}withOpenShifts\(tills \?\? \[\], open\)/);
  });
  await ok('sign-in joins the cashier\'s own open till: no current shift → loadTills → ownOpenTill(staffId) → adopt → /current', () => {
    const c = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    const mount = c.slice(c.indexOf("posApi.get<Shift | null>('/api/shifts/current')"), c.indexOf("posApi.get<Shift | null>('/api/shifts/current')") + 1800);
    assert.match(mount, /const mine = ownOpenTill\(tills, session\.staffId\);[\s\S]{0,60}if \(mine\) \{\s*setCoveredTerminal\(mine\);\s*const joined = await posApi\.get<Shift \| null>\('\/api\/shifts\/current'\);/);
    assert.match(mount, /setShiftModal\('open'\);/);   // anything else → the picker
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
