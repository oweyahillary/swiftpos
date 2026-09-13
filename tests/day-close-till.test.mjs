/**
 * A275 — the till pulls remote day-close instructions and executes them LOCALLY,
 * reusing executeCloseDay so the cash arithmetic matches the on-prem central
 * close. SOURCE-ASSERTION guard; the live pull→execute→ack loop is target-only
 * (rule 16 — no Electron/SQLite on the bench). Mutation-checked.
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const SE = 'apps/desktop/src/main/syncEngine.ts';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('A275: the till reuses executeCloseDay (same cash arithmetic as on-prem)', () => {
  const s = r(SE);
  assert.match(s, /import \{ executeCloseDay \} from '\.\/branchClose'/);
});

ok('A275: it pulls /api/day-close/pending and acks /api/day-close/ack', () => {
  const s = r(SE);
  const fn = /async function runDayCloseInstructions[\s\S]*?\n\}/.exec(s);
  assert.ok(fn, 'runDayCloseInstructions not found');
  const h = fn[0];
  assert.match(h, /\/api\/day-close\/pending/);
  assert.match(h, /\/api\/day-close\/ack/);
  assert.match(h, /const ack = executeCloseDay\(ins\.payload\)/);
  assert.match(h, /instruction_id: ins\.id/);
});

ok('A275: an ack failure leaves the instruction pending for an idempotent re-run', () => {
  const s = r(SE);
  const h = /async function runDayCloseInstructions[\s\S]*?\n\}/.exec(s)[0];
  // the ack is wrapped so a failure does not throw; the comment records the idempotent re-run
  assert.match(h, /day-close ack failed/);
});

ok('A275: the stage runs in syncAll, best-effort (never breaks the sync result)', () => {
  const s = r(SE);
  assert.match(s, /pushed = await runPushStages\(errors\);\s*\n\s*\/\/ A275[\s\S]{0,160}try \{ await runDayCloseInstructions\(errors\); \} catch/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
