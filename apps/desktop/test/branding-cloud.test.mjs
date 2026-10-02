// 0.6.25 — a logo uploaded on the till is saved to the cloud too, so a sync no longer puts the old one back.
//
// Owner, 2026-09-30: "when u upload the logo in the desktop app it removes it after a while why is it so? is it that the
// web config overrides it?" — yes (branding is remote-wins; the tech upload was local only). Decided: the till's upload
// ALSO saves to the cloud.
//
// Drives the REAL compiled dist/main (localDb.setBranding, syncEngine.queueBrandingPush / pushBrandingNow / syncAll) on a
// REAL SQLite file, electron shimmed, against a stand-in cloud.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/branding-cloud.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - the pull applies branding while an upload is pending      → "a pull does not put the old logo back" fails
//   - syncAll pulls before pushing the pending upload            → "the upload goes up BEFORE the pull" fails
//   - a 5xx clears the pending flag                              → "a cloud error keeps it pending" fails
//   - a 4xx leaves it pending                                    → "a refusal … pulls resume" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-brandcloud-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const E = require(path.join(dist, 'syncEngine.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B Foods', '2026-09-30T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1' });

const NEW = 'data:image/png;base64,TkVX', OLD = 'data:image/png;base64,T0xE';
const cloud = { putStatus: 200, puts: [], order: [], logo: OLD };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url).replace('http://cloud', '');
  if (u.startsWith('/api/business/branding') && init.method === 'PUT') {
    cloud.order.push('put');
    cloud.puts.push(JSON.parse(init.body));
    if (cloud.putStatus === 200) cloud.logo = JSON.parse(init.body).logo_png;
    return cloud.putStatus === 200 ? json(200, {}) : json(cloud.putStatus, { error: cloud.putStatus === 403 ? 'Forbidden' : 'boom' });
  }
  if (u.startsWith('/api/pos/init')) {
    cloud.order.push('pull');
    return json(200, { products: [], categories: [], branchId: 'br-1', comboItems: {}, paymentMethods: [],
      branding: { accentHex: null, logoPng: cloud.logo, logoReceipt: null, receiptLogoEnabled: false } });
  }
  return json(200, []);
};
E.configureSyncEngine('http://cloud', 'tok', 'refresh');
const localLogo = () => L.getBranding()?.logoPng ?? null;

console.log('0.6.25 — a till upload is saved to the cloud too\n');

// 1. The cloud is down (500): saved on the till, pending.
cloud.putStatus = 500;
L.setBranding('biz-1', { logoPng: NEW });
let r = await E.queueBrandingPush();
ok('a cloud error keeps it pending (and says it will retry)', r.state === 'pending' && E.brandingPushPending(), JSON.stringify(r));
ok('the PUT carries the till\'s logo and receipt fields', cloud.puts.at(-1)?.logo_png === NEW && 'logo_receipt' in cloud.puts.at(-1) && 'receipt_logo_enabled' in cloud.puts.at(-1));

// 2. A sync while still failing: the pull must NOT put the old logo back.
cloud.order = [];
await E.syncAll();
ok('the upload goes up BEFORE the pull', cloud.order.indexOf('put') > -1 && cloud.order.indexOf('put') < cloud.order.indexOf('pull'), cloud.order.join(','));
ok('a pull does not put the old logo back while the upload is pending', localLogo() === NEW, localLogo());

// 3. The cloud is back: the next sync saves it, and the pull then agrees.
cloud.putStatus = 200;
await E.syncAll();
ok('saved at the next sync; no longer pending', !E.brandingPushPending() && cloud.logo === NEW);
ok('after the pull the till still shows the new logo', localLogo() === NEW);

// 4. Online and accepted straight away.
L.setBranding('biz-1', { logoPng: 'data:image/png;base64,QU5PVEhFUg==' });
r = await E.queueBrandingPush();
ok('online: saved to the cloud at once', r.state === 'saved' && !E.brandingPushPending(), JSON.stringify(r));

// 5. Refused (403): not retried forever; pulls resume; the editor is told why.
cloud.putStatus = 403;
L.setBranding('biz-1', { logoPng: NEW });
r = await E.queueBrandingPush();
ok('a refusal is reported with the reason, and pulls resume (not pending)', r.state === 'refused' && /Forbidden/.test(r.message ?? '') && !E.brandingPushPending(), JSON.stringify(r));

// 6. The editor says how it went.
const editor = fs.readFileSync(path.join(here, '..', 'src/renderer/pages/BrandingEditor.tsx'), 'utf8');
ok('the tech screen says saved / pending / refused', /Saved on this till and to the cloud/.test(editor) && /the cloud refused it/.test(editor) && /Until then, syncing keeps this logo/.test(editor));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
