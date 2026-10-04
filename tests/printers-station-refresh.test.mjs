/**
 * printers-station-refresh.test.mjs — 2026-10-04: a station added on the till's Stations tab appears on its Printers
 * tab at once (owner: "i created the drink printer under stations and it does not appear under printers").
 *
 * The Printers tab's stations came from ManagerPage, read ONCE when the manager screen opened; the Stations tab saved
 * the new one and refreshed only its own list. Source assertions on the till's screens (React, not run here).
 *
 * MUTATION TO CONFIRM BITE: drop `reloadStations?.()` from the tab click → "re-read each time" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const mgr = read('apps/desktop/src/renderer/pages/ManagerPage.tsx');
const scr = read('apps/desktop/src/renderer/screens/PrintersScreen.tsx');

ok('the manager screen reads the stations through one reload, run when it opens', () => {
  assert.match(mgr, /const reloadStations = useCallback\(\(\) => \{/);
  assert.match(mgr, /const rows = await posApi\.manage\.listStations\(\);/);
  assert.match(mgr, /useEffect\(\(\) => \{ reloadStations\(\); \}, \[reloadStations\]\);/);
  assert.match(mgr, /reloadStations=\{reloadStations\}/);
});
ok('the Printers tab re-reads the stations each time it is opened', () => {
  assert.match(scr, /onClick=\{\(\) => \{ setTab\(t\.key\); if \(t\.key === 'printers'\) reloadStations\?\.\(\); \}\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
