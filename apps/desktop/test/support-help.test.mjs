// 0.6.35 (A384) — the till's Help: who to call — the shop's own tech (admin portal), or SwiftPOS support.
//
// Owner, 2026-10-03: "add the number 0717675635 or 0782972023. Also add the feature in admin where i can allocate a tech
// to a shop and the number appears instead of a fixed number". Drives the REAL compiled dist/main (localDb, deviceConfig,
// referenceBundle) on a REAL SQLite file: what the pull stores, what Help shows offline, what a branch server relays.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/support-help.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - setSupportContact ignores null                 → "the admin removes the tech → SwiftPOS support again" fails
//   - setSupportContact writes on undefined          → "an older cloud saying nothing keeps the tech" fails
//   - the node bundle drops `support`                → "a branch server relays the tech to its tills" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0635-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const R = require(path.join(dist, 'referenceBundle.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://x', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1' });

console.log('0.6.35 — Help: the shop\'s own tech, or SwiftPOS support\n');

ok('local schema 65: device_config.support_contact', L.LOCAL_SCHEMA_VERSION >= 65
  && db.prepare(`PRAGMA table_info(device_config)`).all().some((c) => c.name === 'support_contact'));

const fresh = C.getSupportContact();
ok('never told → SwiftPOS support, both numbers', fresh.assigned === false
  && JSON.stringify(fresh.phones) === JSON.stringify(['0717675635', '0782972023']), JSON.stringify(fresh));

C.setSupportContact({ name: 'Brian (SwiftPOS)', phone: '+254 712 345 678' });
const brian = C.getSupportContact();
ok('the pull stores the shop\'s tech (number cleaned to 07…)', brian.assigned && brian.name === 'Brian (SwiftPOS)'
  && brian.phones.length === 1 && brian.phones[0] === '0712345678', JSON.stringify(brian));

C.setSupportContact(undefined);
ok('an older cloud saying nothing keeps the tech', C.getSupportContact().phones[0] === '0712345678');

C.saveDeviceConfig({ device_name: 'Bar 2' });
ok('config:save never touches it (only the pull writes it)', C.getSupportContact().phones[0] === '0712345678');

C.setSupportContact({ name: 'No number', phone: '' });
ok('a tech with no number → SwiftPOS support', C.getSupportContact().assigned === false);

C.setSupportContact({ name: 'Brian (SwiftPOS)', phone: '0712345678' });
C.setSupportContact(null);
ok('the admin removes the tech → SwiftPOS support again', C.getSupportContact().assigned === false
  && C.getSupportContact().phones.length === 2);

// A branch server relays the shop's tech to its tills (offline shop network).
C.setSupportContact({ name: 'Brian (SwiftPOS)', phone: '0712345678' });
const bundle = R.buildReferenceBundle(db, C.getDeviceConfig());
const acq = R.unpackNodeBundle(bundle);
ok('a branch server relays the tech to its tills', acq.config.support?.phone === '0712345678'
  && acq.config.support?.name === 'Brian (SwiftPOS)', JSON.stringify(acq.config.support));

C.setSupportContact(null);
const acqNone = R.unpackNodeBundle(R.buildReferenceBundle(db, C.getDeviceConfig()));
ok('…and "no tech" too (the peer goes back to SwiftPOS support)', acqNone.config.support === null, JSON.stringify(acqNone.config.support));

db.prepare(`UPDATE device_config SET support_contact = NULL WHERE id = 1`).run();
const acqUntold = R.unpackNodeBundle(JSON.parse(JSON.stringify(R.buildReferenceBundle(db, C.getDeviceConfig()))));
ok('a node never told says nothing (the peer keeps its own)', acqUntold.config.support === undefined, JSON.stringify(acqUntold.config.support));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
