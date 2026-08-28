/**
 * device-mac-restore.test.mjs — A182.
 * pickPriorTerminal chooses which prior device's identity a reinstalled machine
 * should inherit: a DIFFERENT device_id, most-recently-seen, with something to
 * restore.
 */
import { pickPriorTerminal } from '../apps/server/src/lib/deviceRestore.ts';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };

const R = (device_id, terminal_code, device_label, last_seen_at) => ({ device_id, terminal_code, device_label, last_seen_at });

// the current (new) install must not be offered its own row
ok('ignores the current device_id', pickPriorTerminal([R('NEW', 'T1', 'Front till', '2026-08-27')], 'NEW') === null);

// offers the prior device's code
ok('offers a prior device\'s terminal code', pickPriorTerminal([R('OLD', 'T1', 'Front till', '2026-08-25')], 'NEW')?.terminal_code === 'T1');

// most recently seen wins among several priors
const many = [R('OLD1', 'T1', 'a', '2026-08-20'), R('OLD2', 'T3', 'b', '2026-08-26'), R('OLD3', 'T2', 'c', '2026-08-24')];
ok('most recently seen prior wins', pickPriorTerminal(many, 'NEW')?.terminal_code === 'T3');

// a prior with nothing to restore is skipped
ok('skips a prior with no code and no label', pickPriorTerminal([R('OLD', null, null, '2026-08-25')], 'NEW') === null);
ok('still offers when only a label exists', pickPriorTerminal([R('OLD', null, 'Front till', '2026-08-25')], 'NEW')?.device_label === 'Front till');

// empty / junk input
ok('null on empty', pickPriorTerminal([], 'NEW') === null);
ok('null on undefined', pickPriorTerminal(undefined, 'NEW') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
