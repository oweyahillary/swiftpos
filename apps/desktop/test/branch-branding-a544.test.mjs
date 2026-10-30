// A544 (2026-10-21) — per-branch branding on the till: a branch can override the business's action theme, brand colour
// and receipt footer (client branding Phase 2, the per-branch slice of A323).
//
// Owner, 2026-10-21: "phase 2 branding — we need to do it before value add" … "yes start" (per-branch branding; the
// design approved in docs/SCOPE-A295-branding.md §14–15: branch override → business branding → ZapTill default, per field).
//
// Drives the REAL compiled dist/main (localDb's migration, syncEngine's whole pull and applyChangeEntries, the branch
// server's reference bundle, getBranding / effectiveReceiptFooter, the shared rule's main copy) on a REAL SQLite file,
// electron shimmed, against a stand-in cloud on a real port; renders a receipt with the REAL @swiftpos/printing.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/branch-branding-a544.test.mjs
//
//   1  local schema 74: the branch_branding table (and REQUIRED_DESKTOP_SCHEMA moves with it).
//   2  the whole pull stores this branch's override; an older cloud (no key) leaves it; null (none, or themes off) clears
//      it; another branch's row is never kept.
//   3  a change: a branch_branding entry is that one row (null = cleared); the themes switch's branding entry carries it.
//   4  the resolver (getBranding().effective): the branch overrides one field, the others follow the business; themes off
//      (the stored effective theme null) → the override ignored; the business values the till's editor edits unchanged.
//   5  the receipt: the branch's footer in the owner's box instead of the business's — the closing thank-you, TAX RECEIPT
//      and the credit still print after it, in the receipt's own font (no ESC M, ESC ! or GS ! around it); no override →
//      the business's footer; the sale print path and pos:init use effectiveReceiptFooter.
//   6  the branch server relays its theme and its branch's override to its tills; an older server's bundle leaves a
//      peer's own.
//   7  the screens wear the effective look (App's theme layer, the lock screen).
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-21):
//   - localDb applyPulledBranchBranding without the undefined → keep              → 2 "an older cloud leaves it" fails
//   - syncEngine applyChangeEntries without the 'branch_branding' case          → 3 "a change is that one row" fails
//   - localDb getBranding effective = the branch row as-is (no resolver)        → 4 "the others follow the business" fails
//   - branchBranding.ts resolve without the business-theme gate                 → 4 "themes off → ignored" + 5 fail
//   - ipcHandlers thankYouMessage back to cfg.receipt_footer                     → 5 "the sale print path" fails
//   - referenceBundle nodeIdentity without branchBranding                        → 6 "relays" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../../../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a544-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false },
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
const BR = 'br-west', BR2 = 'br-kili';
const OVERRIDE = { branchId: BR, themeId: 'violet', accentHex: null, receiptFooter: 'Karibu Westlands\nFollow us @westlands' };
const initWith = (extra) => ({ products: [], categories: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
  vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'restaurant', businessName: 'Test Grill', currency: 'KES',
  receiptFooter: 'Asante sana', themeId: 'ocean',
  branding: { accentHex: '#0d9488', logoPng: null, logoReceipt: null, receiptLogoEnabled: false }, ...extra });
const cloud = { init: initWith({ branchBranding: OVERRIDE }) };
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
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'dev-T1', 'biz-1', 'Test Grill', '2026-10-21T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const RB = require(path.join(dist, 'referenceBundle.js'));
const P = require('@swiftpos/printing');
const rows = () => db.prepare(`SELECT branch_id, theme_id, accent_hex, receipt_footer FROM branch_branding ORDER BY branch_id`).all();

console.log('A544 — per-branch branding on the till\n');
try {
  // ── 1 ──
  const cols = db.prepare(`PRAGMA table_info(branch_branding)`).all().map((c) => c.name);
  const required = Number((fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'lib', 'desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
  ok('local schema 74: branch_branding (branch_id, theme_id, accent_hex, receipt_footer); REQUIRED moves with it',
    L.LOCAL_SCHEMA_VERSION >= 74 && L.getLocalSchemaVersion() === L.LOCAL_SCHEMA_VERSION && required === L.LOCAL_SCHEMA_VERSION
    && ['branch_id', 'theme_id', 'accent_hex', 'receipt_footer'].every((c) => cols.includes(c)), JSON.stringify({ v: L.LOCAL_SCHEMA_VERSION, cols, required }));

  // ── 2 ──
  const r = await E.pullCatalogueNow();
  ok('the whole pull stores this branch\'s override', r.pulled === true && rows().length === 1 && rows()[0].theme_id === 'violet'
    && rows()[0].receipt_footer === OVERRIDE.receiptFooter, JSON.stringify({ r, rows: rows() }));
  cloud.init = initWith({});   // an older cloud: no branchBranding key at all
  await E.pullCatalogueNow();
  ok('an older cloud (no branchBranding): the till keeps it', rows().length === 1 && rows()[0].theme_id === 'violet', JSON.stringify(rows()));
  cloud.init = initWith({ branchBranding: null });
  await E.pullCatalogueNow();
  ok('null (no override, or themes off): the till holds none', rows().length === 0, JSON.stringify(rows()));
  cloud.init = initWith({ branchBranding: { ...OVERRIDE, branchId: BR2 } });
  await E.pullCatalogueNow();
  ok('another branch\'s row is never kept', rows().length === 0, JSON.stringify(rows()));
  cloud.init = initWith({ branchBranding: OVERRIDE });
  await E.pullCatalogueNow();

  // ── 3 ──
  E.applyChangeEntries([{ seq: 1, topic: 'look', table: 'branch_branding', id: BR, op: 'upsert',
    row: { branchBranding: { branchId: BR, themeId: null, accentHex: '#f5b800', receiptFooter: null } } }]);
  ok('a change: a branch_branding entry is that one row (now only the colour)', rows().length === 1 && rows()[0].theme_id === null
    && rows()[0].accent_hex === '#f5b800' && rows()[0].receipt_footer === null, JSON.stringify(rows()));
  E.applyChangeEntries([{ seq: 2, topic: 'look', table: 'branch_branding', id: BR, op: 'upsert', row: { branchBranding: null } }]);
  ok('…cleared on the web (null): gone here', rows().length === 0);
  E.applyChangeEntries([{ seq: 3, topic: 'look', table: 'branding', id: 'branding', op: 'upsert',
    row: { branding: null, themeId: 'ocean', branchBranding: OVERRIDE } }]);
  ok('the themes switch\'s branding entry carries the override too', rows().length === 1 && rows()[0].theme_id === 'violet', JSON.stringify(rows()));
  E.applyChangeEntries([{ seq: 4, topic: 'money', table: 'config', id: 'money', op: 'upsert', row: { vatRate: 16 } }]);
  ok('…a money change (no branchBranding key) leaves it', rows().length === 1);

  // ── 4 ──
  let b = L.getBranding();
  ok('the resolver: the branch overrides its theme only — the colour follows the business; the editor\'s values stay the business\'s',
    b.effective.themeId === 'violet' && b.effective.accentHex === '#0d9488' && b.themeId === 'ocean' && b.accentHex === '#0d9488'
    && b.branch?.branchId === BR, JSON.stringify(b && { e: b.effective, t: b.themeId, a: b.accentHex }));
  L.applyPulledBranchBranding({ branchId: BR, themeId: null, accentHex: '#f5b800', receiptFooter: null });
  b = L.getBranding();
  ok('…a branch overriding only its colour keeps the business theme', b.effective.themeId === 'ocean' && b.effective.accentHex === '#f5b800');
  L.applyPulledBranchBranding({ branchId: BR, themeId: 'emerald', accentHex: '#1e293b', receiptFooter: null });
  b = L.getBranding();
  ok('…a retired theme or a colour too dark to see is not applied (the business\'s instead)', b.effective.themeId === 'ocean' && b.effective.accentHex === '#0d9488');
  L.applyPulledBranchBranding(OVERRIDE);
  L.applyPulledTheme(null);   // themes switched off: the cloud serves no theme
  b = L.getBranding();
  ok('themes off (no effective theme): the override is ignored — today\'s look', b.effective.themeId === null && b.effective.accentHex === '#0d9488',
    JSON.stringify(b.effective));
  ok('…and the receipt prints the business\'s footer', L.effectiveReceiptFooter('Asante sana') === 'Asante sana');
  L.applyPulledTheme('ocean');

  // ── 5 ──
  const footer = L.effectiveReceiptFooter('Asante sana');
  ok('the receipt footer: the branch\'s own instead of the business\'s', footer === OVERRIDE.receiptFooter, JSON.stringify(footer));
  const station = P.receiptPreset('receipt', 'Till', 80);
  const bytes = Buffer.from(P.toEscPos(P.renderTicket({ business: { ...P.sampleBusiness, thankYouMessage: footer || undefined, deliveryMessage: undefined },
    order: P.sampleOrder, station }), { cut: true, feedBeforeCut: 3 }));
  const text = bytes.toString('latin1');
  const at = (s) => text.indexOf(s);
  ok('…printed in the owner\'s box, the author\'s line breaks kept, before the closing thank-you, TAX RECEIPT and the credit',
    at('Karibu Westlands') > 0 && at('Follow us @westlands') > at('Karibu Westlands') && at('Thank you for your business!') > at('Follow us @westlands')
    && at('TAX RECEIPT UPON REQUEST') > at('Thank you for your business!') && at('Powered by ZapTill') > at('TAX RECEIPT UPON REQUEST')
    && at('Asante sana') < 0, JSON.stringify(text.slice(Math.max(0, at('Karibu') - 40), at('Karibu') + 200)));
  const lineAround = (s) => { const i = at(s); return bytes.subarray(bytes.lastIndexOf(0x0a, i) + 1, bytes.indexOf(0x0a, i)); };
  const sizeCodes = (buf) => { for (let i = 0; i < buf.length - 1; i++) { if ((buf[i] === 0x1b && (buf[i + 1] === 0x4d || buf[i + 1] === 0x21)) || (buf[i] === 0x1d && buf[i + 1] === 0x21)) return true; } return false; };
  ok('…in the receipt\'s own font and size (no ESC M, ESC ! or GS ! on its lines — A540 / A543)',
    !sizeCodes(lineAround('Karibu Westlands')) && !sizeCodes(lineAround('Follow us @westlands')));
  L.applyPulledBranchBranding(null);
  ok('no override → the business\'s footer', L.effectiveReceiptFooter('Asante sana') === 'Asante sana');
  L.applyPulledBranchBranding(OVERRIDE);
  const ipc = ipcHandlersSource();
  ok('the sale print path and pos:init use effectiveReceiptFooter (the business footer box text, not the closing block)',
    /thankYouMessage: effectiveReceiptFooter\(\(cfg as any\)\?\.receipt_footer\) \|\| undefined,/.test(ipc)
    && /receiptFooter: effectiveReceiptFooter\(getDeviceConfig\(\)\?\.receipt_footer\),/.test(ipc)
    && /footerCredit:\s+'Powered by ZapTill'/.test(ipc));

  // ── 6 ──
  const bundle = RB.buildReferenceBundle(db, DC.getDeviceConfig());
  ok('the branch server relays its theme and its branch\'s override', bundle.posInit.themeId === 'ocean'
    && bundle.posInit.branchBranding?.branchId === BR && bundle.posInit.branchBranding?.themeId === 'violet', JSON.stringify(bundle.posInit.branchBranding));
  const unpacked = RB.unpackNodeBundle(bundle);
  const { themeId: _t, branchBranding: _bb, ...olderPosInit } = bundle.posInit;   // an older server sends neither key
  const old = RB.unpackNodeBundle(JSON.parse(JSON.stringify({ ...bundle, posInit: olderPosInit })));
  ok('…a peer takes them; an older server\'s bundle leaves the peer\'s own (undefined = not said)',
    unpacked.config.themeId === 'ocean' && unpacked.config.branchBranding?.themeId === 'violet'
    && old.config.themeId === undefined && old.config.branchBranding === undefined);

  // ── 7 ──
  const appTsx = src('renderer/App.tsx');
  const pin = src('renderer/pages/PinPage.tsx');
  ok('the screens wear the effective look: App\'s theme layer and the lock screen read b.effective',
    /computeThemeVars\(b \? \{ themeId: b\.effective\?\.themeId \?\? b\.themeId \?\? null, accentHex: b\.effective \? b\.effective\.accentHex : b\.accentHex(?:,\s*primaryHex: b\.effective\?\.primaryHex \?\? null, secondaryHex: b\.effective\?\.secondaryHex \?\? null)? \} : null\)/.test(appTsx)   // A597: + the brand colours
    && /const accent = b\?\.effective \? b\.effective\.accentHex : b\?\.accentHex \?\? null;/.test(pin)
    && /const theme = b\?\.effective \? b\.effective\.themeId : b\?\.themeId \?\? null;/.test(pin));
} finally {
  srv.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
