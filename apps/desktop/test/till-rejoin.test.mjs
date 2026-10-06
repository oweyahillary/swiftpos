// A415 — the till signs in as itself; a technician rejoins it instead of resetting it.
// Owner, 2026-10-06: "remove any linkage with the desktop app using owners credetials … remove it totally even the
// message at the bottom of the screen i dont want to see it, and add a way a technician can rejoin the app back to the
// bussiness rather than reseting it".
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/till-rejoin.test.mjs
//
// The rejoin's own rules (a code for another branch, the till's own business) are run for real against the cloud in
// tests/till-own-signin.test.mjs; this checks the till's side.
//
// MUTATIONS TO CONFIRM BITE:
//   - the rejoin clearing the catalogue                   → "a rejoin keeps everything on the till" fails
//   - auth:rejoin without the technician check in main    → "only inside an open technician session" fails
//   - the PIN pad's "Sign out / switch account" restored  → "nothing on the PIN screen signs the till out" fails
//   - the branch server turning everyone away on no roster → "an empty roster falls back to the till's own check" fails
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const ipc = src('main/ipcHandlers.ts');
const pin = src('renderer/pages/PinPage.tsx');
const mgr = src('renderer/pages/ManagerPage.tsx');
const app = src('renderer/App.tsx');
const tech = src('renderer/pages/TechPage.tsx');
const join = ipc.slice(ipc.indexOf('const joinBusiness = async'), ipc.indexOf("handle('auth:enrolDevice'"));

console.log('\nNo owner on the till\n');
ok('nothing on the PIN screen signs the till out of the business (no "Sign out / switch account")',
  !/Sign out|switch account|onBackToOwner|confirmSignOut/.test(pin));
ok('nor on the manager screen (no "Sign out business")', !/Sign out business|onSwitchAccount/.test(mgr) && !/onSwitchAccount|onBackToOwner/.test(app));
ok('no channel signs the till out (auth:logout is gone)', !/handle\('auth:logout'/.test(ipc)
  && !/'auth:logout'/.test(src('main/ipcSchemas.ts')) && !/auth:logout/.test(src('main/preload.ts')));
ok('the till\'s session row names the till, never a person', /String\(data\.till\?\.device_id \?\? cfg\?\.device_id \?\? ''\),/.test(join)
  && !/data\.user\.id/.test(ipc)
  && /if \(deviceId && session\.user_id !== deviceId\) db\.prepare\(`UPDATE session SET user_id=\? WHERE id=1`\)\.run\(deviceId\);/.test(ipc));

console.log('\nThe technician rejoins the till\n');
ok('only inside an open technician session — checked in main, not just on the screen',
  /handle\('auth:rejoin', async \(_event, payload\) => \{[\s\S]{0,300}if \(!getActiveSession\(\)\) throw new Error\('Open the technician console first\.'\);/.test(ipc));
ok('a rejoin keeps everything on the till (sales waiting, shifts, menu, settings): nothing is cleared',
  /if \(!rejoin\) clearCatalogue\(db\);/.test(join) && (join.match(/clearCatalogue\(/g) || []).length === 1);
ok('a rejoin is for the till\'s own business only — and sends its branch so a code for another branch is refused unspent',
  /if \(rejoin && current\?\.business_id && current\.business_id !== businessId\) \{/.test(join)
  && /rejoin,\s*\n/.test(join) && /branch_id:\s+cfg\?\.branch_id \?\? undefined,/.test(join));
ok('the till keeps its new device secret and starts syncing again', /writeDeviceSecret\(data\.deviceSecret\)/.test(join)
  && /configureSyncEngine\(getCloudUrl\(\), data\.token, data\.refreshToken \?\? ''\);/.test(join) && /await syncAll\(\)/.test(join));
ok('it is recorded in the technician audit', /logTechAction\('till\.rejoin', \{/.test(ipc));
ok('the technician console has "Rejoin this till" (business ID + code), wired to auth:rejoin',
  /data-testid="tech-rejoin"/.test(tech) && /posApi\.auth\.rejoin\(rejoinBiz\.trim\(\), rejoinCode\.trim\(\)\)/.test(tech)
  && /rejoin:\s+\(business_id: string, code: string\) => ipcRenderer\.invoke\('auth:rejoin', \{ business_id, code \}\)/.test(src('main/preload.ts'))
  && /'auth:rejoin':\s+\{ business_id: \{ t: 'string', min: 1 \}, code: \{ t: 'string', min: 1 \} \}/.test(src('main/ipcSchemas.ts')));

console.log('\nA branch server with no roster yet\n');
ok('an empty roster falls back to the till\'s own check — staff are not turned away',
  /if \(v\.reason !== 'no_roster' && v\.reason !== 'unavailable'\) throw new Error\(v\.message\);/.test(ipc)
  && /if \(n\.reason !== 'no_roster' && n\.reason !== 'unavailable'\) throw/.test(ipc));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
