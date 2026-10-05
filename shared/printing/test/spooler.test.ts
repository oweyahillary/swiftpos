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
import {
  classifySpoolerFailure, parseTarget, spoolerOutcome, spoolerScript,
  SPOOLER_HELPER_CS, SPOOLER_SENT_MARK, SPOOLER_TIMEOUT_MS,
} from '../src/transport';

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

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. 0.6.38 (A397): a slow Windows is said as that, and the ticket is not dropped');

// What Node hands back when execFile's time limit kills PowerShell: no stderr, the command line as the "message".
const killed = () => Object.assign(
  new Error('Command failed: powershell.exe -NoProfile -NonInteractive -Command \n    $ErrorActionPreference = ...'),
  { killed: true, signal: 'SIGTERM', code: null },
);

ok('a printer: target gets 20 seconds (it was 8 — too short for the first print on a slow PC)', () => {
  assert.equal(SPOOLER_TIMEOUT_MS, 20_000);
});

ok('killed by the time limit → timedOut, retryable (the spool tries again), not "our bug"', () => {
  const e = spoolerOutcome('Kitchen', killed(), '', '', SPOOLER_TIMEOUT_MS)!;
  assert.equal(e.timedOut, true);
  assert.equal(e.retryable, true, 'before 0.6.38 this was retryable:false — the spool dropped the kitchen ticket');
  assert.equal(e.internal, false);
  assert.match(e.message, /^Kitchen — Windows took longer than 20 seconds to accept the ticket$/);
});

ok('the raw command line is never the message', () => {
  const e = spoolerOutcome('Kitchen', Object.assign(new Error('Command failed: powershell.exe -NoProfile -NonInteractive -Command x'), { code: 1 }), '', '', SPOOLER_TIMEOUT_MS)!;
  assert.doesNotMatch(e.message, /powershell|NoProfile|Command failed/i);
  assert.match(e.message, /the Windows print helper stopped without giving a reason/);
  assert.equal(e.internal, true);
  assert.doesNotMatch(classifySpoolerFailure('Kitchen', 'Command failed: powershell.exe -NoProfile').message, /NoProfile/);
});

ok('once the spooler has the bytes, it printed — whatever happens after (never printed twice)', () => {
  assert.equal(spoolerOutcome('Kitchen', killed(), `${SPOOLER_SENT_MARK}\r\n`, '', SPOOLER_TIMEOUT_MS), null);
  assert.equal(spoolerOutcome('Kitchen', null, '', '', SPOOLER_TIMEOUT_MS), null);
});

ok('a spooler fault is still a printer fault; our script failing is still ours', () => {
  const e = spoolerOutcome('Kitchen', Object.assign(new Error('Command failed'), { code: 1 }), '', "OpenPrinter failed for 'Kitchen' (1801)", 20000)!;
  assert.equal(e.timedOut, false); assert.equal(e.internal, false); assert.equal(e.retryable, false);
  assert.match(e.message, /does not recognise that printer name/);
  assert.equal(spoolerOutcome('Kitchen', Object.assign(new Error('x'), { code: 1 }), '', 'Empty path name is not legal', 20000)!.internal, true);
});

ok('the helper is built once and reused; any trouble with that falls back to building it in memory, as before', () => {
  const ps = spoolerScript();
  const at = (re: RegExp) => { const m = re.exec(ps); assert.ok(m, String(re)); return m!.index; };
  const loadCached = at(/if \(\$helper -and \(Test-Path -LiteralPath \$helper\)\) \{\n\s+try \{ Add-Type -LiteralPath \$helper \} catch \{/);
  const build = at(/try \{\n\s+Add-Type -TypeDefinition \$sig -Language CSharp -OutputAssembly \$part -OutputType Library/);
  const fallback = at(/if \(-not \('SwiftRaw' -as \[type\]\)\) \{ Add-Type -TypeDefinition \$sig -Language CSharp \}/);
  const send = at(/\[SwiftRaw\]::Send\(\$printer, \$bytes\)/);
  const mark = at(new RegExp(`\\[Console\\]::Out\\.WriteLine\\('${SPOOLER_SENT_MARK}'\\)`));
  assert.ok(loadCached < build && build < fallback && fallback < send && send < mark, 'load → build → in-memory fallback → send → mark');
  // the build to a file is inside a try that swallows — so it can never stop a print
  assert.match(ps, /\} catch \{ \}\n\s+\}\n\s+if \(-not \('SwiftRaw' -as \[type\]\)\) \{ Add-Type -TypeDefinition/);
  // the C# is in the script, unchanged, inside a single-quoted here-string (nothing in it is expanded)
  assert.ok(ps.includes(`$sig = @'\n${SPOOLER_HELPER_CS}'@`));
  assert.match(SPOOLER_HELPER_CS, /public static class SwiftRaw/);
  assert.match(SPOOLER_HELPER_CS, /di\.pDatatype = "RAW";/);
  // values still travel only in the environment
  assert.match(ps, /\$helper = \$env:SWIFTPOS_HELPER/);
  assert.doesNotMatch(ps, /\$args/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
