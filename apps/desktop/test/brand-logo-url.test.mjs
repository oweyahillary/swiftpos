// brand-logo-url.test.mjs — the desktop shows the Cloudinary brand-logo URL DIRECTLY when online, so the on-screen logo is
// not lost when the one-time base64 byte-cache fails (the regression after the brand logo moved from base64-in-DB to a
// Cloudinary URL and the backfill nulled the base64). applyPulledBranding stores the URL EAGERLY (not only after the byte
// cache succeeds), getBranding returns it, and the screens render it with the cached base64 as the OFFLINE fallback.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/brand-logo-url.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - applyPulledBranding storing logo_url ONLY via cacheLogoFromUrl → "the URL is stored even when the byte cache fails" fails
//   - getBranding not selecting logo_url                             → "getBranding returns the logo URL" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-logourl-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B Foods', '2026-11-16T00:00:00Z')`).run();

const URL1 = 'https://res.cloudinary.com/dwlztvvpj/image/upload/v1/logo.png';
// Make the byte-cache fetch FAIL, so ONLY the eager URL store can make the logo available (the regression scenario).
globalThis.fetch = async () => { throw new Error('offline'); };

console.log('desktop brand logo — the Cloudinary URL shows directly; a byte-cache failure does not lose it\n');

// A post-backfill pull: a Cloudinary URL and NO base64.
L.applyPulledBranding({ accentHex: null, logoPng: null, logoUrl: URL1 });
await new Promise((r) => setTimeout(r, 50));   // let the fire-and-forget cacheLogoFromUrl settle (it fails → no-op)
let b = L.getBranding();
ok('getBranding returns the logo URL', b?.logoUrl === URL1, JSON.stringify(b));
ok('the URL is stored even when the byte cache fails (the regression fix)', b?.logoUrl === URL1 && (b?.logoPng ?? null) === null);

// Clearing the logo clears the URL too.
L.applyPulledBranding({ accentHex: null, logoPng: null, logoUrl: null });
ok('a cleared logo clears the URL', (L.getBranding()?.logoUrl ?? null) === null);

// An older cloud (logoUrl field absent) keeps the stored URL rather than clearing it.
L.applyPulledBranding({ accentHex: null, logoPng: null, logoUrl: URL1 });
L.applyPulledBranding({ accentHex: null, logoPng: null });   // logoUrl undefined → keep
ok('an older cloud (no logoUrl field) keeps the stored URL', L.getBranding()?.logoUrl === URL1);

console.log('\nSource — the three screens prefer the URL with the cached base64 as the offline fallback');
for (const f of ['src/renderer/pages/PinPage.tsx', 'src/renderer/components/LockCurtain.tsx', 'src/renderer/pages/ManagerPage.tsx']) {
  const s = fs.readFileSync(path.join(here, '..', f), 'utf8');
  ok(`${f} reads logoUrl and falls back on <img> error`, /b\?\.logoUrl/.test(s) && /onError=/.test(s));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
