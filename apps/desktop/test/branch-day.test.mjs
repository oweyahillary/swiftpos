/**
 * branch-day.test.mjs — A431 / A432: a manager on ANY till sees every till's sales and every shift on the Overview, with a
 * shift report; from the cloud with the manager's own sign-in, else what this till holds — and the screen says which.
 *
 *   node test/branch-day.test.mjs
 *
 * Pins on the source (React and the cloud are not run here; the figures are tested on the cloud side,
 * tests/branch-report.test.mjs).
 *
 * MUTATIONS TO CONFIRM BITE: the cloud call made with the till's session token → "a manager's own sign-in" fails; a till
 * filter put back on the local shift query → "the local shift report has no till filter" fails; one Overview back on
 * salesSummary() → "every Overview reads the branch" fails; the scope line dropped → its pin fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const day = read('src/main/branchDay.ts');
const cloud = day.slice(day.indexOf('export async function cloudBranchDay'), day.indexOf('export function localBranchDay'));
const local = day.slice(day.indexOf('export function localBranchDay'), day.indexOf('export async function branchDay'));

ok("a manager's own sign-in (A415: the till's session is not a person)",
  /const token = readStaffTokens\(\)\.token;\s*if \(!token\) throw new Error\(/.test(cloud) && !/readSessionTokens/.test(day));
ok('the cloud is asked for the branch, through the branch server on a peer (cloudFetch, A410)',
  /cloudFetch\(`\$\{getCloudUrl\(\)\}\/api\/shifts\/branch-report\?\$\{q\}`/.test(cloud));
ok('no cloud → what this till holds, with the reason',
  /try \{\s*return await cloudBranchDay\(range\);\s*\} catch \(e\) \{\s*return localBranchDay\(range, /.test(day));
ok('the local shift report has no till filter (on a branch server that is every till)',
  /FROM shifts s LEFT JOIN users u/.test(local) && !/device_id,''\) = /.test(local) && !/WHERE s\.device_id/.test(local));
ok('it says what it shows', /source: 'cloud',\s*scopeLabel: 'All tills at this branch'/.test(cloud) && /source: 'local',\s*scopeLabel:/.test(local));

ok('the IPC channel is handled, bridged and validated',
  /handle\('manager:branchDay', async \(_e, r\?: RangeArg\) => branchDay\(resolveRange\(/.test(read('src/main/ipcHandlers.ts'))
  && /branchDay: +\(range\?: any\) => ipcRenderer\.invoke\('manager:branchDay', range\)/.test(read('src/main/preload.ts'))
  && /'manager:branchDay': +\{ \.\.\.rangeArg \}/.test(read('src/main/ipcSchemas.ts')));

const mp = read('src/renderer/pages/ManagerPage.tsx');
ok('every Overview reads the branch (restaurant, petrol, retail) — none reads this till only',
  // A441: each asks for the day the manager chose.
  (mp.match(/posApi\.manager\.branchDay\(overviewRange\(date\)\)/g) || []).length === 3 && !/posApi\.manager\.salesSummary\(\)/.test(mp));
ok('every Overview says what it shows and has the shift report',
  (mp.match(/<ScopeLine day=\{sales\} \/>/g) || []).length === 3
  && (mp.match(/<BranchShiftsAndTills day=\{sales\} currency=\{currency\} when=\{when\} \/>/g) || []).length === 3);
ok('the shift report: till, cashier, time, sales, expected, counted, difference, status',
  /data-testid="overview-shift-report"/.test(mp)
  && ['Till', 'Cashier', 'Time', 'Sales', 'Expected cash', 'Counted', 'Difference', 'Status'].every(h => mp.includes(`font-medium${h === 'Till' || h === 'Cashier' || h === 'Time' || h === 'Status' ? '' : ' text-right'}">${h}</th>`)));
ok('Top sellers: every till from the cloud; "(this till)" only when it is',
  /Top sellers — \$\{when\}\$\{sales && sales\.source !== 'cloud' && !sales\.localCoversBranch \? ' \(this till\)' : ''\}/.test(mp)
  && mp.includes("setTopItems(s?.source === 'cloud' ? (s.topProducts ?? []).slice(0, 8) : t)"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
