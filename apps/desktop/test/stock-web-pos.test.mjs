// A346 (2026-09-27) — the till's Stock screen only for a business with the web POS.
// Owner: "stock should not appear in the desktop app thats a web pos feature pro feature" → "stock should only appear if the
// web pos is enabled"; web POS enabled = web access fully usable (active, or in the grace weeks after expiry).
//
// RUNS the real compiled deviceConfig + localDb (SQLite, electron shimmed) and the real referenceBundle (node → peer relay).
// The pull wiring and the manager screen are pinned by source (Electron/React not run here). The cloud's answer is
// tests/stock-web-pos.test.mjs.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/stock-web-pos.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - saveDeviceConfig writes web_pos_enabled from the patch (in its INSERT) → "config:save can never switch it on" fails
//   - setWebPosEnabled writes on undefined                          → "an older cloud (no field) leaves it alone" fails
//   - the node does not relay it (webPosEnabled dropped)            → "a peer learns it from its node" fails
//   - the manager screen shows Stock without web_pos_enabled        → "Stock only with the web POS" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a346-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = {
  app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.6.15', on() {}, isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
  net: { isOnline: () => false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class {} };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const D = require(path.join(dist, 'deviceConfig.js'));
const R = require(path.join(dist, 'referenceBundle.js'));
const db = L.getLocalDb();

ok('local schema 56: device_config.web_pos_enabled exists', L.LOCAL_SCHEMA_VERSION === 56
  && db.prepare(`PRAGMA table_info(device_config)`).all().some((c) => c.name === 'web_pos_enabled'), String(L.LOCAL_SCHEMA_VERSION));

D.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_role: 'till', terminal_code: 'T1' });
ok('a till that has not heard from the cloud: not known (null) — the screen treats that as NO', D.getDeviceConfig().web_pos_enabled === null);

D.setWebPosEnabled(true);
ok('the cloud says yes → stored', D.getDeviceConfig().web_pos_enabled === true);
D.saveDeviceConfig({ receipt_header: 'Hello' });
ok('…and kept across an ordinary settings save', D.getDeviceConfig().web_pos_enabled === true);
D.setWebPosEnabled(undefined);
ok('an older cloud (no field) leaves it alone', D.getDeviceConfig().web_pos_enabled === true);
D.setWebPosEnabled(false);
ok('the cloud says no (subscription lapsed) → stored as no', D.getDeviceConfig().web_pos_enabled === false);
D.saveDeviceConfig({ web_pos_enabled: true });
ok('config:save can never switch it on (only the cloud pull writes it)', D.getDeviceConfig().web_pos_enabled === false);

// ── Node → peer relay (real referenceBundle) ──
const fakeDb = { prepare: () => ({ all: () => [] }) };
const viaNode = (cfgValue) => R.unpackNodeBundle(JSON.parse(JSON.stringify(R.buildReferenceBundle(fakeDb, { branch_id: 'br-1', web_pos_enabled: cfgValue })))).config.webPosEnabled;
ok('a peer learns it from its node: yes → yes, no → no', viaNode(true) === true && viaNode(false) === false);
ok('a node that has not heard yet says nothing (the peer keeps its own value)', viaNode(null) === undefined);
ok('an older node (no field in its bundle) says nothing', R.unpackNodeBundle({ posInit: {} }).config.webPosEnabled === undefined);

// ── The pull and the screen (source) ──
const se = src('main/syncEngine.ts');
ok('the cloud pull reads webPosEnabled (a real boolean only) and stores it', /webPosEnabled: typeof _j\.webPosEnabled === 'boolean' \? _j\.webPosEnabled : undefined,/.test(se)
  && /setWebPosEnabled\(c\.webPosEnabled\);/.test(se));
const mp = src('renderer/pages/ManagerPage.tsx');
ok('Stock only with the web POS: the manager screen checks web_pos_enabled === true before anything else',
  /if \(cfg\?\.web_pos_enabled !== true\) \{ if \(live\) setShowStock\(false\); return; \}/.test(mp));
ok('…and a stale jump to the Stock page falls back to the overview', /case 'stock':\s+return showStock \? <StockTab currency=\{currency\} \/> : <RetailOverview/.test(mp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
