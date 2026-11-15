/**
 * branch-tabs-ux.test.mjs — Till stage 3b: the PURE shared-tables decisions used by CashierScreen
 * (apps/dashboard/src/pages/pos/branchTabsUx.ts). No React: the module is pure, so this compiles it with esbuild and
 * exercises the decision table directly.
 *
 *   node --no-warnings tests/branch-tabs-ux.test.mjs
 *
 * MUTATIONS CONFIRMED TO BITE (each made, seen to fail, reverted):
 *   - tapAction preferring 'take-node' over 'resume-local'      → "a local order resumes, never re-claims as foreign"
 *   - claimAction treating 'locked' as 'open'                   → "a live foreign lock is read-only, not opened"
 *   - editLost returning true for 'unreachable'                 → "unreachable keeps the table (local), only 'lost' drops it"
 *   - takeOverAction treating 'refused' as 'open'               → "a wrong PIN / no permission must never open the table"
 *   - takeOverAction treating 'unreachable' as 'open'           → "a silent server asks to retry, never silently opens"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 300)}`); fail++; } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'btux-'));
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'apps/dashboard/src/pages/pos/branchTabsUx.ts')],
  bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, 'out.cjs'), logLevel: 'silent',
});
const M = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

console.log('\ntableOccupied');
eq('local order → occupied', M.tableOccupied(true, false), true);
eq('node tab → occupied', M.tableOccupied(false, true), true);
eq('neither → free', M.tableOccupied(false, false), false);

console.log('\nheldBy');
eq('last editor wins', M.heldBy({ id: 't', opened_by: 'Ann', last_changed_by: 'Jane' }), 'Jane');
eq('falls back to opener', M.heldBy({ id: 't', opened_by: 'Ann', last_changed_by: null }), 'Ann');
eq('neutral when unknown', M.heldBy({ id: 't', opened_by: '', last_changed_by: '  ' }), 'another POS');

console.log('\ntapAction');
eq('a local order resumes, never re-claims as foreign', M.tapAction(true, true, true), 'resume-local');
eq('a node tab with sharing on → take-node', M.tapAction(false, true, true), 'take-node');
eq('a node tab but sharing off → open-free', M.tapAction(false, true, false), 'open-free');
eq('free → open-free', M.tapAction(false, false, true), 'open-free');

console.log('\nclaimAction');
eq('claimed (not stolen) opens the cart, no toast',
  M.claimAction({ outcome: 'claimed', tab: { cart: [{ x: 1 }] }, stole: false }, 'T4'),
  { kind: 'open', cart: [{ x: 1 }], toast: null });
{
  const a = M.claimAction({ outcome: 'claimed', tab: { cart: [] }, stole: true }, 'T4');
  ok('a stolen (lapsed) lease toasts', a.kind === 'open' && /idle/.test(a.toast || ''));
}
eq('a bad cart becomes []', M.claimAction({ outcome: 'claimed', tab: { cart: 'oops' }, stole: false }, 'T4').cart, []);
eq('a live foreign lock is read-only, not opened', M.claimAction({ outcome: 'locked', lockedBy: 'd' }, 'T4'), { kind: 'held' });
eq('unreachable → fallback (local)', M.claimAction({ outcome: 'unreachable' }, 'T4'), { kind: 'fallback' });
eq('an unexpected refused on a plain claim stays local (never opens)', M.claimAction({ outcome: 'refused', reason: 'other', message: 'x' }, 'T4'), { kind: 'fallback' });

console.log('\ntakeOverAction (manager force-claim)');
{
  const a = M.takeOverAction({ outcome: 'claimed', tab: { cart: [{ x: 1 }] }, stole: true, approvedBy: 'Mary' }, 'T4');
  ok('granted → open the taken-over cart with an approver toast',
    a.kind === 'open' && JSON.stringify(a.cart) === JSON.stringify([{ x: 1 }]) && /Mary/.test(a.toast) && /T4/.test(a.toast), JSON.stringify(a));
}
{
  const a = M.takeOverAction({ outcome: 'claimed', tab: { cart: [] }, stole: true }, 'T4');
  ok('granted without an approver name still opens (generic toast)', a.kind === 'open' && !/approved by/i.test(a.toast), JSON.stringify(a));
}
eq('a bad cart becomes [] on take-over', M.takeOverAction({ outcome: 'claimed', tab: { cart: 'oops' }, stole: true }, 'T4').cart, []);
eq('a wrong PIN is refused, surfaced verbatim (never opens)',
  M.takeOverAction({ outcome: 'refused', reason: 'pin', message: 'That PIN was not recognised.' }, 'T4'),
  { kind: 'refused', message: 'That PIN was not recognised.' });
eq('a permission refusal is surfaced',
  M.takeOverAction({ outcome: 'refused', reason: 'permission', message: 'Mary may not take over tables.' }, 'T4'),
  { kind: 'refused', message: 'Mary may not take over tables.' });
{
  const a = M.takeOverAction({ outcome: 'unreachable' }, 'T4');
  ok('an unreachable server asks to retry (never silently opens)', a.kind === 'retry' && /try the take-over again/i.test(a.message), JSON.stringify(a));
}
{
  const a = M.takeOverAction({ outcome: 'locked', lockedBy: 'd' }, 'T4');
  ok('an unexpected locked answer asks to retry, never opens', a.kind === 'retry', JSON.stringify(a));
}

console.log('\neditLost');
eq('lost → drop', M.editLost({ outcome: 'lost' }), true);
eq('ok keeps', M.editLost({ outcome: 'ok' }), false);
eq('unreachable keeps the table (local), only lost drops it', M.editLost({ outcome: 'unreachable' }), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
