// product-days.test.mjs — 0.6.31: a product shown on the grid only on chosen days (still sold any day), on the till.
//
// Owner, 2026-10-02: "show products only on chosen days, but the product should be able to sell anyday not just the
// selected day". Runs the BUILT main process (dist/main) against a real SQLite file: the local column (schema 62), the
// branch node relaying the days to its peers, and the pull / grid wiring by source.
//
// MUTATIONS TO CONFIRM BITE:
//   - the node bundle drops show_days                        → "the node relays the days" fails
//   - the pull stores show_days unconverted / not at all      → "the pull stores the days" fails
//   - pos:init does not hand the days to the screen           → "the screen gets the days" fails
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0631-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const B = require(path.join(dist, 'referenceBundle.js'));
const D = require(path.join(dist, 'productDays.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

console.log('0.6.31 — products shown on chosen days (till)\n');
const db = L.getLocalDb();
ok('local schema 62: products.show_days', L.LOCAL_SCHEMA_VERSION >= 62
  && db.prepare(`PRAGMA table_info(products)`).all().some((c) => c.name === 'show_days'));

db.prepare(`INSERT INTO products (id, name, base_price, status, show_days) VALUES ('p-offer', 'Tue & Thu Offer', 1200, 'active', '[2,4]')`).run();
db.prepare(`INSERT INTO products (id, name, base_price, status, show_days) VALUES ('p-pizza', 'Margherita Pizza', 750, 'active', NULL)`).run();
const bundle = B.buildReferenceBundle(db, {});
const byId = Object.fromEntries((bundle.posInit?.products ?? []).map((p) => [p.id, p]));
ok('the node relays the days to its peers (an array), and every-day products as null',
  JSON.stringify(byId['p-offer']?.show_days) === '[2,4]' && byId['p-pizza']?.show_days === null, JSON.stringify(byId['p-offer']));
ok('the till reads the days the same way as the web (shared rule)', JSON.stringify(D.cleanShowDays('[2,4]')) === '[2,4]');

const eng = src('main/syncEngine.ts');
ok('the pull stores the days (JSON array; an older cloud sends none → every day)',
  /show_days:\s+\(\(\) => \{ const d = cleanShowDays\(\(p as any\)\.show_days\); return d \? JSON\.stringify\(d\) : null; \}\)\(\),/.test(eng)
  && /is_kitchen=excluded\.is_kitchen, show_days=excluded\.show_days,/.test(eng));
ok('the screen gets the days (pos:init)', /show_days: cleanShowDays\(p\.show_days\) \?\? null,/.test(src('main/ipcHandlers.ts')));
ok('the grid: its days only, unless searching; barcode lookup unchanged (any day)',
  /const matchDay    = onGrid\(\(p as any\)\.show_days, search\.trim\(\) !== ''\);/.test(src('renderer/pages/POSPage.tsx')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
