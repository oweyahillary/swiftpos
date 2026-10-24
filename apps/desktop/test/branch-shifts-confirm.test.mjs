/**
 * branch-shifts-confirm.test.mjs — A433 (owner, 2026-10-10: "yes if they have logged in as the manager, and under sales
 * report it should cover all tills when logged in as the manager").
 *
 *   node test/branch-shifts-confirm.test.mjs
 *
 * Pins on the source (React and the cloud are not run here; the cloud side is tests/shift-zreport.test.mjs):
 *   · a signed-in manager confirms ANY till's shift — this till's on its own record, another till's on the cloud as
 *     themselves (never the replay field `confirmed_by`, which only the holding till may send);
 *   · the till that holds a shift confirmed elsewhere takes the confirmation (its Close Day stops waiting);
 *   · Sales covers every till: Orders opens on every till, Item Mix reads the branch, Shift report lists every till's.
 *
 * MUTATIONS TO CONFIRM BITE: `confirmed_by` sent by remoteConfirm → "as themselves" fails; the pulled confirmation not
 * limited to this till's shifts → its pin fails; the Overview confirming another till's shift locally → "remote for
 * another till" fails; Orders back to 'till' first → its pin fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const ipc = ipcHandlersSource();
const remote = ipc.slice(ipc.indexOf("handle('shift:remoteConfirm'"), ipc.indexOf("handle('shift:remoteConfirm'") + 1600);

console.log('\nConfirming another POS\'s shift\n');
ok('on the cloud, as the signed-in manager (manageFetch) — or a manager\'s PIN', remote.includes("manageFetch(`/api/shifts/${encodeURIComponent(shiftId)}/manager-confirm`, 'POST', {")
  && /const me = signedInConfirmer\(\);\s*if \(!me && !String\(pin \?\? ''\)\.trim\(\)\) throw new Error\(/.test(remote));
ok('as themselves — never `confirmed_by` (the holding till\'s replay)', !/confirmed_by:\s*(me|counts|shiftId)/.test(remote.slice(0, remote.indexOf('logLine('))));
ok('the confirm screen reads and saves on the cloud for another till',
  /\(remote \? posApi\.shift\.remoteConfirmView\(shiftId\) : posApi\.shift\.confirmView\(shiftId\)\)/.test(read('src/renderer/components/ConfirmShiftModal.tsx'))
  && /const confirm = remote \? posApi\.shift\.remoteConfirm : posApi\.shift\.confirm;/.test(read('src/renderer/components/ConfirmShiftModal.tsx')));

const mp = read('src/renderer/pages/ManagerPage.tsx');
ok('Overview: Confirm on a shift awaiting a manager, for a signed-in manager — remote for another till',
  /\{sh\.state === 'awaiting' && done\[sh\.id\] === undefined && canConfirm && \(/.test(mp) && /remote=\{!confirming\.this_till\}/.test(mp));
ok('Shift report: Confirm this shift — this till\'s on its record, another\'s on the cloud',
  /\{awaiting && canConfirm && \(\s*<button data-testid="zreport-confirm"/.test(mp) && /remote=\{remote\(selected\)\}/.test(mp)
  && /const remote = \(id: string\) => !local\.has\(id\);/.test(mp));

console.log('\nThe POS that holds the shift learns of it\n');
const se = read('src/main/syncEngine.ts');
const pull = se.slice(se.indexOf('export async function pullShiftConfirmations'), se.indexOf('// A404 — the cloud\'s test-data clears'));
ok('only this till\'s closed shifts awaiting a manager, already on the cloud, not being confirmed here',
  /status = 'closed' AND declared_methods IS NOT NULL AND confirmed_at IS NULL\s*AND COALESCE\(confirm_sync, ''\) <> 'pending' AND sync_status = 'synced'\s*AND COALESCE\(device_id,''\) = COALESCE\(\?,''\)/.test(pull));
ok('takes the cloud\'s confirmation as it stands — no push back', /confirm_sync = 'synced'/.test(pull) && /WHERE id = @id AND confirmed_at IS NULL/.test(pull));
ok('asked on the 20 s beat', /pullShiftConfirmations\(\)\.catch\(console\.error\);/.test(read('src/main/index.ts')));

console.log('\nSales covers every POS\n');
ok('Orders opens on every till', /const \[scope, setScope\] = useState<'till' \| 'branch'>\('branch'\);/.test(mp));
ok('Item Mix reads the branch and says which', /posApi\.manager\.branchDay\(range\)\s*\.then\(d => \{/.test(mp) && /data-testid="item-mix-scope"/.test(mp));
ok('Shift report lists every till\'s shifts (the cloud), else this till\'s and says so',
  /posApi\.manager\.branchShifts\(\)/.test(mp) && /Shifts on other points of sale need the cloud — showing this POS's only\./.test(mp));
ok('the IPC calls are bridged', ['manager:branchShifts', 'manager:remoteZReport', 'shift:remoteConfirmView', 'shift:remoteConfirm']
  .every((c) => read('src/main/preload.ts').includes(`'${c}'`)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
