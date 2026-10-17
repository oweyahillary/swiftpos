/**
 * A275 — the till pulls remote day-close instructions and executes them LOCALLY,
 * reusing executeCloseDay so the cash arithmetic matches the on-prem central
 * close. SOURCE-ASSERTION guard; the live pull→execute→ack loop is target-only
 * (rule 16 — no Electron/SQLite on the bench). Mutation-checked.
 *
 * A523: A521 split the stage in two — runDayCloseInstructions is now a single-flight wrapper (the 90 s beat and the full
 * sync never run it side by side) and the pull → execute → ack body is runDayCloseInstructionsOnce. The intent is kept:
 * the BODY is what is asserted (it pulls, executes, acks, survives a lost ack), and the wrapper is asserted to be the
 * single-flight guard that calls it. A523 also pins the ack's `code` (DRAWER_OPEN / SHIFTS_UNCONFIRMED — A522 asked).
 * The end-to-end loop runs for real in apps/desktop/test/self-closing-days-a523.test.mjs.
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const SE = 'apps/desktop/src/main/syncEngine.ts';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };
// A523: the body (A521's runDayCloseInstructionsOnce), up to the next top-level function.
const body = () => {
  const fn = /async function runDayCloseInstructionsOnce\([\s\S]*?\n\}\n/.exec(r(SE));
  assert.ok(fn, 'runDayCloseInstructionsOnce not found');
  return fn[0];
};

ok('A275: the till reuses executeCloseDay (same cash arithmetic as on-prem)', () => {
  const s = r(SE);
  assert.match(s, /import \{ executeCloseDay \} from '\.\/branchClose'/);
});

ok('A275: it pulls /api/day-close/pending and acks /api/day-close/ack', () => {
  const h = body();
  assert.match(h, /\/api\/day-close\/pending/);
  assert.match(h, /\/api\/day-close\/ack/);
  assert.match(h, /const ack = executeCloseDay\(ins\.payload\)/);
  assert.match(h, /instruction_id: ins\.id/);
});

ok('A275: an ack failure leaves the instruction pending for an idempotent re-run', () => {
  // the ack is wrapped so a failure does not throw; the comment records the idempotent re-run
  assert.match(body(), /day-close ack failed/);
});

ok('A521/A523: runDayCloseInstructions is the single-flight wrapper around the body', () => {
  const w = /async function runDayCloseInstructions\(errors: string\[\]\)[\s\S]*?\n\}/.exec(r(SE));
  assert.ok(w, 'runDayCloseInstructions not found');
  assert.match(w[0], /if \(_dayCloseInFlight\) return;/);
  assert.match(w[0], /try \{ await runDayCloseInstructionsOnce\(errors\); \} finally \{ _dayCloseInFlight = false; \}/);
});

ok('A523: the ack carries the reason as a code (DRAWER_OPEN / SHIFTS_UNCONFIRMED) and the wait flag', () => {
  const h = body();
  assert.match(h, /code: {4}ack\.code \?\? null,/);
  assert.match(h, /wait: {4}ack\.wait === true,/);
});

ok('A275: the stage runs in syncAll, best-effort (never breaks the sync result)', () => {
  const s = r(SE);
  assert.match(s, /pushed = await runPushStages\(errors\);\s*\n\s*\/\/ A275[\s\S]{0,160}try \{ await runDayCloseInstructions\(errors\); \} catch/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
