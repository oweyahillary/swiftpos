/**
 * shift-join-owner.test.mjs — the owner joins a shift running on the web POS (owner, 2026-11-04, on dev: two shifts
 * running, "when i try joining a shift i get the error" — "That drawer has just been closed").
 *
 * Cause: an owner's web POS session (A608, opened from the dashboard) names no branch — the owner names it per request.
 * GET /api/shifts/current named none either, so the cloud keyed the web till's drawer to "web:" instead of
 * "web:<branch>" and never found the running shift. Opening worked: POST /open carries branch_id in its body.
 * Fix: the web sends ?branch_id= on every /current read (currentShiftPath), and terminalKeyFromRequest reads it when the
 * session and the body name no branch.
 *
 *   node tests/shift-join-owner.test.mjs
 *
 * RUNS the real terminalKeyFromRequest (apps/server/src/lib/terminalKey.ts) and currentShiftPath
 * (apps/dashboard/src/lib/posTerminal.ts); the four web calls are pinned by source.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - terminalKeyFromRequest ignores req.query.branch_id          → "the owner's read finds web:<branch>" fails
 *   - the query wins over the session's own branch                 → "a session's own branch wins over the query" fails
 *   - one of the four web reads calls '/api/shifts/current' bare   → "every web read of the current shift names the branch" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.SHIFT_JOIN_OWNER_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, SHIFT_JOIN_OWNER_TS: '1' } });
  process.exitCode = r.status ?? 1;
} else {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  let pass = 0, fail = 0;
  const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
  const { terminalKeyFromRequest } = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/terminalKey.ts')).href);
  const { currentShiftPath } = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/posTerminal.ts')).href);
  const req = (o) => ({ headers: {}, body: {}, query: {}, branchId: null, deviceId: null, ...o });

  console.log('\nThe cloud: which drawer a request means\n');
  ok('the owner\'s read finds web:<branch> (no branch in the session, the branch in the query)', () => {
    assert.equal(terminalKeyFromRequest(req({ query: { branch_id: 'br-mama' } })), 'web:br-mama');
  });
  ok('the owner\'s open is unchanged: the branch in the body', () => {
    assert.equal(terminalKeyFromRequest(req({ body: { branch_id: 'br-mama' } })), 'web:br-mama');
  });
  ok('a session\'s own branch wins over the query (a cashier cannot point at another branch\'s web drawer)', () => {
    assert.equal(terminalKeyFromRequest(req({ branchId: 'br-own', query: { branch_id: 'br-other' } })), 'web:br-own');
  });
  ok('a covered till still wins (x-device-id): the till\'s drawer, whatever the branch', () => {
    assert.equal(terminalKeyFromRequest(req({ headers: { 'x-device-id': 'dev-T1' }, query: { branch_id: 'br-mama' } })), 'dev-T1');
  });
  ok('nothing named anywhere: as before ("web:")', () => {
    assert.equal(terminalKeyFromRequest(req({})), 'web:');
  });

  console.log('\nThe web POS\n');
  ok('currentShiftPath names the branch, or asks plainly without one', () => {
    assert.equal(currentShiftPath('br mama'), '/api/shifts/current?branch_id=br%20mama');
    assert.equal(currentShiftPath(null), '/api/shifts/current');
  });
  ok('every web read of the current shift names the branch (mount, own drawer, join, open fold-in)', () => {
    const files = ['apps/dashboard/src/pages/pos/CashierScreen.tsx', 'apps/dashboard/src/pages/pos/ShiftModal.tsx'];
    const all = files.map(read).join('\n');
    assert.equal((all.match(/'\/api\/shifts\/current'/g) ?? []).length, 0, 'a bare /api/shifts/current read is left');
    assert.equal((all.match(/currentShiftPath\(/g) ?? []).length, 4);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
