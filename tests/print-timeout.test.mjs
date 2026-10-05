/**
 * print-timeout.test.mjs — 0.6.38 (A397): printing to a Windows printer (`printer:Kitchen`) on a slow PC.
 *
 * Owner, 2026-10-04: every `printer:` station failed on one PC with "Command failed: powershell.exe -NoProfile
 * -NonInteractive -Command" — PowerShell building the print helper took longer than the 8 s limit. The rules (time
 * limit, helper built once, what a timeout means) are tested for real in shared/printing/test/spooler.test.ts; this
 * pins the till's Test print and its message.
 *
 * MUTATIONS TO CONFIRM BITE: timedOut not passed back by escpos:test → "Test print says…" fails; the screen's timeout
 * message removed → same.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const t = read('shared/printing/src/transport.ts');
ok('a printer: target gets its own, longer time limit; the others keep 8 s', () => {
  assert.match(t, /export const SPOOLER_TIMEOUT_MS = 20_000;/);
  assert.match(t, /const timeoutMs = opts\.timeoutMs \?\? \(target\.kind === 'spooler' \? SPOOLER_TIMEOUT_MS : 8000\);/);
  assert.match(t, /const failure = spoolerOutcome\(name, err, String\(stdout \?\? ''\), String\(stderr \?\? ''\), timeoutMs\);/);
});

ok('Test print says "Windows took too long", not "printer off" and not "a fault in ZapTill"', () => {
  assert.match(read('apps/desktop/src/main/print/printWorker.ts'), /timedOut: \(!isOurs && e\.timedOut\) \|\| undefined,/);
  const s = read('apps/desktop/src/renderer/screens/PrinterSetupScreen.tsx');
  assert.match(s, /timedOut\?: boolean;/);
  assert.match(s, /: result\.timedOut\n\s+\? 'Windows took too long to accept the job\. Press Test print again/);
  assert.ok(s.indexOf('result.timedOut') < s.indexOf("'Looks like the printer is off or unreachable"), 'the timeout is said before the "printer off" guess');
});

ok('the background queue retries a timed-out ticket instead of dropping it', () => {
  assert.match(read('apps/desktop/src/main/print/printWorker.ts'), /isRetryable: \(e: unknown\) => \(e instanceof PrinterError \? e\.retryable : true\),/);
  assert.match(t, /`\$\{name\} — Windows took longer than \$\{Math\.round\(timeoutMs \/ 1000\)\} seconds to accept the ticket`,\n\s+true,/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
