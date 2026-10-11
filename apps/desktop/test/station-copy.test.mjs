// A446 — a print station added on the web (or another till) prints on this till at once.
// Owner's screenshot, 2026-10-11: a new station "Barister" listed on Manager › Settings › Printing; Test print said
// 'No station "a6173c80-…"' and the preview "No such station." The screen listed the CLOUD's stations; printing reads
// THIS TILL's copy (print_stations), which only a menu pull refreshed — and station changes did not count as a change.
//
// Registers the REAL handlers and the REAL print worker on a real SQLite file, a stand-in cloud with a station this till
// has never seen; the cloud's 20-s check and the pull's source, read from source.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/station-copy.test.mjs
//
// MUTATIONS TO CONFIRM BITE: manage:listStations not writing the till's copy → "Test print finds it" fails; print_stations
// out of the cloud's change check → its pin fails; the change pull from the branch server's copy → its pin fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a446s-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'device:d', 'biz-1', 'Krunch', '2026-10-11T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, 'u-abdi', 'Abdi', 'manager', '{"*":true}', 'br-1', 'tok', '2026-10-11T06:00:00Z')`).run();
require(path.join(dist, 'tokenStore.js')).writeStaffTokens({ token: 'tok', refreshToken: 'r' });
db.prepare(`INSERT INTO print_stations (id, name, kind, sort_order, active, synced_at) VALUES ('st-kitchen', 'Kitchen', 'kitchen', 0, 1, '2026-10-11')`).run();

const BARISTER = 'a6173c80-3fbc-4c04-80b5-9e0ea1fa0080';
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/api/stations')) {
    return new Response(JSON.stringify([
      { id: 'st-kitchen', name: 'Kitchen', kind: 'kitchen', sort_order: 0, active: true, category_ids: [] },
      { id: BARISTER, name: 'Barister', kind: 'kitchen', sort_order: 3, active: true, category_ids: ['cat-coffee'] },
    ]), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
require(path.join(dist, 'print', 'printWorker.js')).initPrinting(db, () => null);
const H = global.__handlers;

{
  const before = await H['escpos:preview'](null, { stationId: BARISTER, paperWidthMm: 80 });
  ok('(before the screen opens: this till has never seen Barister — "No such station.")', /no such station/i.test(String(before)), String(before).slice(0, 80));
  const list = await H['manage:listStations'](null);
  ok('the Printing screen lists Barister (from the cloud)', list.some((s) => s.id === BARISTER));
  ok('…and this till now holds it, with its routing', !!db.prepare(`SELECT 1 FROM print_stations WHERE id = ?`).get(BARISTER)
    && !!db.prepare(`SELECT 1 FROM category_stations WHERE station_id = ? AND category_id = 'cat-coffee'`).get(BARISTER));
  const after = await H['escpos:preview'](null, { stationId: BARISTER, paperWidthMm: 80 });
  ok('Preview (and Test print) find it at once — not \'No station "…"\'', !/no such station/i.test(String(after)) && String(after).length > 20, String(after).slice(0, 80));
}
{
  const pos = fs.readFileSync(path.join(root, 'apps/server/src/routes/pos.ts'), 'utf8');
  ok('a station added or changed anywhere counts as a change on the tills\' 20-s check', /latest\('print_stations',\s+'business_id', biz\)/.test(pos));
  const sync = fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8');
  ok('…and that change is pulled from the cloud, not the branch server\'s possibly older copy',
    /const nodeBundle = _preferCloudPull \? null : await fetchReferenceFromNode\(\);/.test(sync) && /_preferCloudPull = true;/.test(sync));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
