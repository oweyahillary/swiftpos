// A597 (2026-10-28) — the owner's brand colours on the till: a primary and a secondary colour, any colour, chosen on the
// web's Settings › Branding (premium: the business's `themes` flag). The till wears them like the web POS.
//
// Drives the REAL compiled dist/main (localDb's columns, syncEngine's whole pull, getBranding's resolver, the branch
// server's reference bundle) on a REAL SQLite file, electron shimmed, against a stand-in cloud on a real port; and the
// REAL renderer lib/themeVars.ts, bundled with the repo's esbuild.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/brand-colours-a597.test.mjs
//
//   1  no local schema bump (pulled only — migrateColumns adds branding.primary_hex / secondary_hex on every start).
//   2  the whole pull stores them; an older cloud (no key) leaves them; null clears; junk is stored as none.
//   3  getBranding().effective: the colours while themes are on; none with themes off; none under a branch's own theme.
//   4  a database without the columns (before this build ran its migration) reads as "no colours", never an error.
//   5  the branch server relays them to its tills; an older server's bundle leaves a peer's own.
//   6  the screens: themes off → nothing overridden; a primary → its shades on every action variable (white, black,
//      yellow, mid-grey: labels read); the lock screen / strip: the accent when set, else the primary's visible shade;
//      the secondary beside it on the strip.
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-28):
//   - localDb applyPulledBranding writing primary_hex even when undefined          → 2 "an older cloud leaves them" fails
//   - localDb getBranding effective without the colours                            → 3 "the colours while themes are on" fails
//   - getBrandColours without its try/catch                                        → 4 fails
//   - referenceBundle nodeIdentity without the colours                             → 5 "relays" fails
//   - themeVars computeThemeVars ignoring primaryHex                               → 6 "a primary → its palette" fails
//   - themeVars brandColourVars using the primary even when an accent is set       → 6 "the accent keeps the lock screen" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a597-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.22', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, session: { fromPartition: () => ({}) }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { if (req === 'electron') return shim; return orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

// ── The stand-in cloud ───────────────────────────────────────────────────────────────────────────────────────────────
const BR = 'br-west';
const initWith = (branding, extra = {}) => ({ products: [], categories: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
  vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'retail', businessName: 'Test Shop', currency: 'KES',
  receiptFooter: 'Asante sana', themeId: 'violet', branchBranding: null,
  branding: { accentHex: null, logoPng: null, logoReceipt: null, receiptLogoEnabled: false, ...branding }, ...extra });
const cloud = { init: initWith({ primaryHex: '#e11d48', secondaryHex: '#ffff00' }) };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'x-zaptill-server': '1' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/api/pos/init') return send(200, cloud.init);
  if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff: [] });
  if (/\/api\/(inventory|tables|pumps|stations|staff)/.test(u.pathname)) return send(200, []);
  return send(200, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const CLOUD = `http://127.0.0.1:${srv.address().port}`;

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-T1', 'biz-1', 'Test Shop', '2026-10-28T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const RB = require(path.join(dist, 'referenceBundle.js'));
const stored = () => db.prepare(`SELECT primary_hex, secondary_hex FROM branding LIMIT 1`).get();

// The renderer's themeVars, bundled.
const esbuild = require('esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a597-tv-'));
esbuild.buildSync({ entryPoints: [path.join(desktop, 'src/renderer/lib/themeVars.ts')], bundle: true, format: 'esm',
  outfile: path.join(tmp, 'themeVars.mjs'), logLevel: 'silent' });
const TV = await import(pathToFileURL(path.join(tmp, 'themeVars.mjs')).href);
esbuild.buildSync({ entryPoints: [path.join(desktop, '../../packages/core/src/themes.ts')], bundle: true, format: 'esm',
  outfile: path.join(tmp, 'themes.mjs'), logLevel: 'silent' });
const T = await import(pathToFileURL(path.join(tmp, 'themes.mjs')).href);

console.log('A597 — the owner\'s brand colours on the till\n');
try {
  // ── 1 ──
  const cols = db.prepare(`PRAGMA table_info(branding)`).all().map((c) => c.name);
  const required = Number((fs.readFileSync(path.join(desktop, '..', 'server', 'src', 'lib', 'desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
  // A607 moved the local schema to 78 (orders.buyer_kra_pin); A597 itself bumped nothing (77 when it shipped).
  ok('branding.primary_hex / secondary_hex exist; no schema bump for A597 (77 when it shipped — A607 made it 78 — REQUIRED with it)',
    cols.includes('primary_hex') && cols.includes('secondary_hex') && L.LOCAL_SCHEMA_VERSION >= 77 && required === L.LOCAL_SCHEMA_VERSION, JSON.stringify({ cols, v: L.LOCAL_SCHEMA_VERSION, required }));

  // ── 2 ──
  const r = await E.pullCatalogueNow();
  ok('the whole pull stores the colours', r.pulled === true && stored().primary_hex === '#e11d48' && stored().secondary_hex === '#ffff00', JSON.stringify({ r, s: stored() }));
  cloud.init = initWith({});   // an older cloud: no primaryHex / secondaryHex keys
  await E.pullCatalogueNow();
  ok('an older cloud (no keys) leaves them', stored().primary_hex === '#e11d48' && stored().secondary_hex === '#ffff00', JSON.stringify(stored()));
  cloud.init = initWith({ primaryHex: null, secondaryHex: 'not-a-colour' });
  await E.pullCatalogueNow();
  ok('null clears; anything but #rrggbb is stored as none', stored().primary_hex === null && stored().secondary_hex === null, JSON.stringify(stored()));
  cloud.init = initWith({ primaryHex: '#E11D48', secondaryHex: '#ffff00' });
  await E.pullCatalogueNow();
  ok('…stored lower case', stored().primary_hex === '#e11d48');

  // ── 3 ──
  let b = L.getBranding();
  ok('effective: the colours while themes are on (the business\'s, as pulled)', b.effective.primaryHex === '#e11d48' && b.effective.secondaryHex === '#ffff00'
    && b.primaryHex === '#e11d48', JSON.stringify(b.effective));
  L.applyPulledBranchBranding({ branchId: BR, themeId: 'teal', accentHex: null, receiptFooter: null });
  b = L.getBranding();
  ok('a branch\'s own theme wins: no colours under it', b.effective.themeId === 'teal' && b.effective.primaryHex === null && b.effective.secondaryHex === null, JSON.stringify(b.effective));
  L.applyPulledBranchBranding({ branchId: BR, themeId: null, accentHex: '#f5b800', receiptFooter: null });
  b = L.getBranding();
  ok('a branch overriding only its colour keeps the business\'s brand colours', b.effective.primaryHex === '#e11d48' && b.effective.accentHex === '#f5b800');
  L.applyPulledBranchBranding(null);
  L.applyPulledTheme(null);   // themes switched off: the cloud serves no theme (and no colours)
  b = L.getBranding();
  ok('themes off: no colours applied — today\'s look', b.effective.themeId === null && b.effective.primaryHex === null, JSON.stringify(b.effective));
  L.applyPulledTheme('violet');

  // ── 5 ── (before 4, which removes the columns)
  const bundle = RB.buildReferenceBundle(db, DC.getDeviceConfig());
  ok('the branch server relays the colours with the branding', bundle.posInit.branding?.primaryHex === '#e11d48' && bundle.posInit.branding?.secondaryHex === '#ffff00',
    JSON.stringify(bundle.posInit.branding && { p: bundle.posInit.branding.primaryHex, s: bundle.posInit.branding.secondaryHex }));
  const idNew = RB.identityFromWire({ branding: { accentHex: null, logoPng: null, primaryHex: '#000000', secondaryHex: null } });
  const idOld = RB.identityFromWire({ branding: { accentHex: null, logoPng: null } });
  ok('…a peer takes them; an older server\'s bundle (no keys) leaves the peer\'s own (undefined = not said)',
    idNew.branding.primaryHex === '#000000' && idNew.branding.secondaryHex === null && idOld.branding.primaryHex === undefined && idOld.branding.secondaryHex === undefined);

  // ── 4 ──
  db.exec(`ALTER TABLE branding DROP COLUMN primary_hex; ALTER TABLE branding DROP COLUMN secondary_hex;`);
  let threw = null;
  try { b = L.getBranding(); } catch (e) { threw = e; }
  ok('a database without the columns: getBranding works, no colours (never an error)', !threw && b && b.effective.primaryHex === null && b.effective.themeId === 'violet', String(threw ?? JSON.stringify(b?.effective)));

  // ── 6 ──
  ok('themes off (no theme) → nothing overridden, whatever colours are stored', TV.computeThemeVars({ themeId: null, primaryHex: '#e11d48' }) === null);
  const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
  const lum = (c) => { const [r, g, bl] = c.split(' ').map((v) => { const x = Number(v) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const con = (a, c) => { const x = lum(a), y = lum(c); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // A605: the key action is the palette's dark-screen primary (500 = 600), with ONE label (on-action) that reads on it,
  // its hover and its pressed shade; links on 400; the label swap itself is index.css :root[data-brand].
  let worst = { label: 99, link: 99 };
  for (const hex of ['#ffffff', '#000000', '#ffff00', '#808080', '#000080', '#e11d48', '#facc15', '#0b1f3a', '#16a34a']) {
    const t = TV.computeThemeVars({ themeId: 'violet', primaryHex: hex });
    const d = T.brandPalette(hex).dark;
    if (t.vars['action-500'] !== ch(d.primary) || t.vars['action-600'] !== ch(d.primary) || t.vars['action-400'] !== ch(d.text) || t.vars['on-action'] !== ch(d.onPrimary)) { worst = null; break; }
    for (const f of ['action-500', 'action-700', 'action-hover']) worst.label = Math.min(worst.label, con(t.vars['on-action'], t.vars[f]));
    worst.link = Math.min(worst.link, con(t.vars['action-400'], '17 24 39'), con(t.vars['action-400'], '31 41 55'), con(t.vars['action-300'], '17 24 39'));
  }
  ok(`a primary → its palette on the action colours, one label readable on fill / pressed / hover, links readable (${worst && Object.values(worst).map((x) => x.toFixed(2)).join(' / ')})`,
    worst && worst.label >= 4.5 && worst.link >= 4.5, JSON.stringify(worst));
  const full = TV.computeThemeVars({ themeId: 'violet', primaryHex: '#000080', secondaryHex: '#ffff00' });
  ok('…every POS variable is set (switching off removes them all)', TV.THEME_VAR_NAMES.every((n) => typeof full.vars[n] === 'string'));
  ok('no accent: the lock screen and strip wear the primary at its shade seen on the dark screens — one colour (A605)',
    full.vars['brand-600'] === ch(T.brandPalette('#000080').layer) && full.strip === T.brandPalette('#000080').layer && full.brand === true
    && TV.stripBackground(full) === full.strip, JSON.stringify(full));
  const acc = TV.computeThemeVars({ themeId: 'violet', accentHex: '#F5B800', primaryHex: '#000080' });
  ok('the lock-screen accent, when set, keeps the lock screen and strip (the primary still drives the buttons)',
    acc.vars['brand-600'] === '245 184 0' && acc.strip === '#F5B800' && acc.vars['action-600'] === ch(T.brandPalette('#000080').dark.primary)
    && TV.stripBackground(acc) === '#F5B800');
  const theme = TV.computeThemeVars({ themeId: 'violet', accentHex: null });
  ok('no colours → the curated theme exactly as before (Violet 500, no strip)', theme.vars['action-500'] === '139 92 246' && theme.strip === null && !theme.strip2);
  const appTsx = src('renderer/App.tsx'), pin = src('renderer/pages/PinPage.tsx');
  ok('the screens read the effective colours: App\'s layer (with the two-colour strip) and the lock screen',
    /primaryHex: b\.effective\?\.primaryHex \?\? null, secondaryHex: b\.effective\?\.secondaryHex \?\? null/.test(appTsx) && /setBrandStrip\(stripBackground\(t\)\);/.test(appTsx)
    && /setAccentHex\(accent \?\? \(primary \? primary\.layer : theme \? resolveTheme\(theme\)\.shades\[500\] : null\)\);/.test(pin));
} finally {
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
