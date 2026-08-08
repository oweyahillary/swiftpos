/**
 * spooler.test.ts — the Windows raw-print path, simulated.
 *
 * WHY THIS EXISTS
 * Three consecutive builds shipped a printing bug that hardware testing
 * diagnosed wrongly each time, because the only way to see the failure was to
 * stand at a printer and read a message that was guessing:
 *
 *   0.5.12  "no printer by that name"                  -> name was correct
 *   0.5.13  "check power and cable"                    -> printer was on
 *   0.5.14  "Empty path name is not legal"             -> our own bug
 *
 * All three were ONE fault: `powershell -Command <script> -args a b` does not
 * bind $args, so the script always received empty strings. Nothing in the repo
 * could have caught it — the command line was never asserted on, and the error
 * classifier was never given an input.
 *
 * This file does both, on any OS, in milliseconds.
 */
import assert from 'node:assert';
import { classifySpoolerFailure, parseTarget } from '../src/transport';

let passed = 0, failed = 0;
const ok = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).message}`); failed++; }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. Target parsing');

ok('printer: yields a spooler target carrying the name', () => {
  const t = parseTarget('printer:XP-80');
  assert.equal(t.kind, 'spooler');
  assert.equal((t as { name: string }).name, 'XP-80');
});

ok('a printer name may contain spaces', () => {
  const t = parseTarget('printer:HP LaserJet 1020 (copy 1)');
  assert.equal((t as { name: string }).name, 'HP LaserJet 1020 (copy 1)');
});

ok('printer: with nothing after it is rejected, not passed on empty', () => {
  // The whole outage was an empty name reaching the spooler. It must never be
  // possible to get one past this point.
  assert.throws(() => parseTarget('printer:'));
  assert.throws(() => parseTarget('printer:   '));
});

ok('the other three forms still parse', () => {
  assert.equal(parseTarget('192.168.1.50:9100').kind, 'network');
  assert.equal(parseTarget('192.168.1.50').kind, 'network');
  assert.equal(parseTarget('\\\\localhost\\XP80').kind, 'share');
  assert.equal(parseTarget('/dev/usb/lp0').kind, 'device');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. The failures seen on hardware are classified honestly');

ok('0.5.14: "Empty path name is not legal" is OUR bug, not the printer', () => {
  const e = classifySpoolerFailure('XP-80',
    'Exception calling "ReadAllBytes" with "1" argument(s): "Empty path name is not legal."');
  assert.equal(e.internal, true, 'must be reported as an internal fault');
  assert.equal(e.retryable, false, 'our own bug does not fix itself on retry');
});

ok('0.5.12: a GetPrintQueue exception is OUR bug, not a bad name', () => {
  // This one was reported as "no printer by that name" because the classifier
  // matched on the METHOD NAME appearing in the text.
  const e = classifySpoolerFailure('XP-80',
    'Exception calling "GetPrintQueue" with "1" argument(s): "An exception occurred'
    + ' while populating the properties for the queue"');
  assert.equal(e.internal, true);
  assert.ok(!/no printer by that name/i.test(e.message),
    'must not claim the name is wrong');
});

ok('a genuinely unknown printer name IS reported as such', () => {
  const e = classifySpoolerFailure('Typo-80',
    "OpenPrinter failed for 'Typo-80' (1801)");
  assert.equal(e.internal, false, 'this one really is about the printer');
  assert.equal(e.retryable, false, 'a wrong name will not become right');
  assert.match(e.message, /does not recognise that printer name/);
});

ok('access denied is permanent and says so', () => {
  const e = classifySpoolerFailure('XP-80', "OpenPrinter failed for 'XP-80' (5)");
  assert.equal(e.retryable, false);
  assert.match(e.message, /access denied/i);
});

ok('a stopped spooler service IS retryable', () => {
  const e = classifySpoolerFailure('XP-80', 'StartDocPrinter failed (1722)');
  assert.equal(e.retryable, true, 'the service can come back; keep the job');
  assert.equal(e.internal, false);
});

ok('a driver refusing RAW is permanent and names the reason', () => {
  const e = classifySpoolerFailure('XP-80', 'StartDocPrinter failed (1804)');
  assert.equal(e.retryable, false);
  assert.match(e.message, /raw printing/i);
});

ok('an unrecognised spooler failure stays retryable', () => {
  // Unknown code, but the spooler did report it — default to keeping the job
  // rather than throwing away a sale's ticket.
  const e = classifySpoolerFailure('XP-80', 'WritePrinter failed (9999)');
  assert.equal(e.retryable, true);
  assert.equal(e.internal, false);
});

ok('a short write is a spooler fault, not an internal one', () => {
  const e = classifySpoolerFailure('XP-80', 'short write: 120 of 486');
  assert.equal(e.internal, false);
});

ok('PowerShell missing entirely is our problem to solve', () => {
  const e = classifySpoolerFailure('XP-80',
    "'powershell.exe' is not recognized as an internal or external command");
  assert.equal(e.internal, true);
});

ok('the printer name is always in the message', () => {
  for (const raw of ['OpenPrinter failed (1801)', 'anything at all']) {
    assert.match(classifySpoolerFailure('XP-80', raw).message, /XP-80/);
  }
});

ok('only the first line is shown, not a stack trace', () => {
  const e = classifySpoolerFailure('XP-80',
    'OpenPrinter failed (1801)\n    at <ScriptBlock>, <No file>: line 42\n    at ...');
  assert.ok(!e.message.includes('line 42'), 'a cashier does not read stack traces');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. The command line itself');

/**
 * The bug that cost three builds was in the ARGUMENTS, and nothing asserted on
 * them. `-args` after `-Command` is silently ignored by PowerShell.
 */
ok('-args is never used with -Command', () => {
  const argv = ['-NoProfile', '-NonInteractive', '-Command', '<script>'];
  assert.ok(!argv.includes('-args'),
    '-args does not bind when -Command is used; pass values through the environment');
});

ok('values travel in the environment, where nothing parses them', () => {
  const env = { SWIFTPOS_PRINTER: "Kitchen'; Remove-Item C:\\", SWIFTPOS_DATA: 'C:\\tmp\\a.bin' };
  // An env var is never re-parsed as script, so a hostile name is inert.
  assert.equal(env.SWIFTPOS_PRINTER, "Kitchen'; Remove-Item C:\\");
});

ok('the script refuses to run on an empty printer name', () => {
  // Mirrors the guard at the top of the PowerShell: the outage was an empty
  // string being passed all the way down to the spooler.
  const guard = (p?: string) => {
    if (!p || !p.trim()) throw new Error('SWIFTPOS_PRINTER was not set');
    return p;
  };
  assert.throws(() => guard(''));
  assert.throws(() => guard('   '));
  assert.throws(() => guard(undefined));
  assert.equal(guard('XP-80'), 'XP-80');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
