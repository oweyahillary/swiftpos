/**
 * pos-print-retry.test.mjs — one-tap Retry of a failed print on a Shop POS (apps/android/src/shop/printRetry.ts, wired in
 * shop/printing.ts, surfaced by screens/shop/PrintNotice.tsx).
 *
 *   node --no-warnings tests/pos-print-retry.test.mjs      (bundles the pure retry module; the seam + notice are source-checked)
 *
 * WHY: a printer that is off used to leave the cashier to dig the ticket out of History. Now printing.ts remembers the last
 * FAILED print and PrintNotice offers Retry; switch the printer on, tap once. A bad ADDRESS is a setup mistake, not a
 * retryable failure, so it must NOT arm Retry.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - printBytes not calling clearRetry on success          → "a success forgets the retry" fails
 *   - printBytes not arming retry in the catch              → "a failure arms a retry" fails
 *   - arming a retry on the bad-address path                → "a bad address is NOT retryable" fails
 *   - PrintNotice showing Retry unconditionally             → "the notice gates Retry on canRetry" fails
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 900)}`); fail++; } };

function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/android', 'apps/dashboard', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-'));
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export * from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/printRetry.ts'))};
`);
esbuild.buildSync({
  entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'out.cjs'), resolveExtensions: ['.ts', '.tsx', '.js', '.json'], logLevel: 'silent',
});
const M = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

const run = async () => {
  console.log('\nprintRetry (pure)');
  {
    const s = M.makeRetryState();
    ok('a fresh state has nothing to retry', M.canRetry(s) === false);
    await M.runRetry(s);   // no-op, must not throw
    ok('retry with nothing remembered is a no-op', true);
    M.rememberRetry(s, async () => {});
    ok('remembering a print arms a retry', M.canRetry(s) === true);
    M.clearRetry(s);
    ok('clearing forgets it', M.canRetry(s) === false);
  }
  {
    // The real cycle printing.ts drives: fail arms a retry; the retry succeeds and clears itself.
    const s = M.makeRetryState();
    let tries = 0;
    const printOnce = async () => {
      tries++;
      if (tries < 2) { M.rememberRetry(s, printOnce); throw new Error('printer off'); }
      M.clearRetry(s);
    };
    let threw = null;
    try { await printOnce(); } catch (e) { threw = e; }
    ok('a failure arms a retry', threw !== null && M.canRetry(s) === true);
    await M.runRetry(s);
    ok('the retry re-runs the very same print', tries === 2);
    ok('a success forgets the retry', M.canRetry(s) === false);
  }

  console.log('\nSource — shop/printing.ts wiring');
  {
    const src = read('apps/android/src/shop/printing.ts');
    ok('a print failure arms a retry (direct bytes)', /catch \(e\)[\s\S]*?rememberRetry\(retryState, \(\) => printBytes\(target, bytes\)\)/.test(src));
    ok('a print success clears the retry', /RawPrinter\.send\([\s\S]*?\);\s*\n\s*clearRetry\(retryState\)/.test(src));
    ok('the branch-server path arms a retry too', /rememberRetry\(retryState, async \(\) => \{ await printOrder\(job, order\); \}\)/.test(src) && /said = true; armRetry\(\);/.test(src));
    ok('a bad address is NOT retryable (no arm on the !addr path)', /if \(!addr\) \{ notePrintProblem\(notAnAddress\(target\)\); throw new Error\(notAnAddress\(target\)\); \}/.test(src));
    ok('it exports the notice hooks', /export function canRetryLastPrint/.test(src) && /export async function retryLastPrint/.test(src));
    ok('notePrintProblem is unchanged (still a plain string event)', /new CustomEvent<string>\(PRINT_PROBLEM_EVENT, \{ detail: words \}\)/.test(src));
  }

  console.log('\nSource — PrintNotice.tsx');
  {
    const src = read('apps/android/src/screens/shop/PrintNotice.tsx');
    ok('the notice imports the retry hooks', /canRetryLastPrint/.test(src) && /retryLastPrint/.test(src));
    ok('the notice gates Retry on canRetry', /canRetry &&[\s\S]*?data-testid="print-retry"/.test(src));
    ok('a successful retry clears the notice', /await retryLastPrint\(\);\s*\n\s*setWords\(null\)/.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
run();
