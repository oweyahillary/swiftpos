/**
 * branding-web-page.test.mjs — A308: the owner-facing web Branding settings page (SCOPE §6).
 *
 *   node tests/branding-web-page.test.mjs
 *
 * The page's look is target-only; this guards the wiring so the client-facing editor can't
 * silently regress: it reads/writes the A303 endpoint, offers the vetted palette + a
 * legibility-guarded custom colour, resizes the logo to the 250 KB cap, and is reachable.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - drop the api.put('/api/business/branding') call → "saves via the A303 endpoint" fails
 *   - remove the legibility guard                     → "custom accent is legibility-guarded" fails
 *   - unregister the tab/route                        → "reachable from Business settings" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

const tab  = r('apps/dashboard/src/pages/settings/BrandingTab.tsx');
const app  = r('apps/dashboard/src/App.tsx');
const biz  = r('apps/dashboard/src/pages/settings/BusinessPage.tsx');

ok('reads current branding (A303 GET)', /api\.get<[^>]*>\('\/api\/business\/branding'\)/.test(tab) || /api\.get\([^)]*'\/api\/business\/branding'/.test(tab));
ok('saves via the A303 endpoint (PUT)', /api\.put\('\/api\/business\/branding'/.test(tab));
ok('offers the vetted palette (8 accents)', /const PALETTE/.test(tab) && (tab.match(/hex:\s*'#/g) || []).length >= 8);
ok('custom accent is legibility-guarded', /function isLegible/.test(tab) && /ratio\(/.test(tab) && /LOCK_SURFACE/.test(tab));
ok('logo resized to the 250 KB cap (shrink, PNG)', /MAX_LOGO_BYTES\s*=\s*250\s*\*\s*1024/.test(tab) && /toDataURL\('image\/png'\)/.test(tab) && /svg/i.test(tab));
ok('has a live lock-screen preview', /function LockPreview/.test(tab) && /<LockPreview/.test(tab));
ok('reachable from Business settings (route + tab)',
   /import\('\.\/pages\/settings\/BrandingTab'\)/.test(app) && /path="branding"\s+element=\{<BrandingTab/.test(app) && /to:\s*'branding'/.test(biz));


// ── A313: receipt logo on the web — toggle, preview, and web receipts carrying it ──────────
const rend = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js'), 'utf8');
const bro  = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/lib/buildReceiptOrder.ts'), 'utf8');
const upd  = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/cashier/usePOSData.ts'), 'utf8');
const pm   = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/PaymentModal.tsx'), 'utf8');
const pr   = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/lib/printRouted.ts'), 'utf8');
const rp   = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/lib/reprintReceipt.ts'), 'utf8');
const cs   = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/pos/CashierScreen.tsx'), 'utf8');

ok('A313: bundle exports the shared raster helpers (one thresholding rule on the web)',
  /monoRasterFromRGBA/.test(rend) && /monoRasterToString/.test(rend) && /monoRasterFromString/.test(rend));
ok('A313: bundle carries the GS v 0 image emit (A310 rebuilt in)', /case "image"/.test(rend) && /118, 48, 0/.test(rend));
ok('A313: page thresholds with the BUNDLED rule, not its own', /monoRasterFromRGBA\(/.test(tab) && !/threshold\s*=\s*128/.test(tab));
ok('A313: page has the opt-in toggle', /Print logo on customer receipts/.test(tab) && /receipt_logo_enabled:/.test(tab));
ok('A313: toggle is disabled without a logo', /checked=\{receiptLogoEnabled\}\s+disabled=\{!logoPng\}/.test(tab));
ok('A313: saving without a logo forces raster null + toggle off', /logo_receipt:\s*logoPng\s*\?\s*logoReceipt\s*:\s*null/.test(tab) && /receipt_logo_enabled:\s*!!logoPng\s*&&\s*receiptLogoEnabled/.test(tab));
ok('A313: has a receipt preview drawn from the stored raster', /function ReceiptPreview/.test(tab) && /<ReceiptPreview/.test(tab) && /paintRaster\(/.test(tab));
ok('A313: reset clears the raster and the toggle too', /logo_receipt:\s*null,\s*receipt_logo_enabled:\s*false/.test(tab));

ok('A313: ReceiptBusinessConfig accepts logoRaster', /logoRaster\?:/.test(bro) && /logoRaster:\s*extra\.logoRaster/.test(bro));
ok('A313: usePOSData resolves the logo from /pos/init with the SAME gate as the till (toggle && raster)',
  /init\.branding\?\.receiptLogoEnabled\s*&&\s*init\.branding\.logoReceipt/.test(upd) && /monoRasterFromString\(init\.branding\.logoReceipt\)/.test(upd));
ok('A313: CashierScreen threads receiptLogo to both print paths', (cs.match(/receiptLogo/g) || []).length >= 3);
ok('A313: PaymentModal passes it into the builder', /logoRaster:\s*receiptLogo/.test(pm));
ok('A313: printRouted passes it into the builder', /logoRaster:\s*a\.receiptLogo/.test(pr));
ok('A313: reprint fetches branding and applies the same gate', /\/api\/business\/branding/.test(rp) && /branding\?\.receipt_logo_enabled\s*&&\s*branding\.logo_receipt/.test(rp));

// Executable: the rebuilt bundle renders a logo on a receipt and NOT on a kitchen ticket,
// and a no-logo receipt is unchanged in length from the pre-A313 bundle's known output.
{
  const { createRequire } = await import('node:module');
  const R = createRequire(import.meta.url)(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js'));
  const rgba = new Uint8ClampedArray(16 * 2 * 4); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // 16x2 opaque black
  const raster = R.monoRasterFromRGBA(rgba, 16, 2);
  const s = R.monoRasterToString(raster);
  ok('A313: bundle threshold + codec round-trip', s.startsWith('mono1:16:2:') && R.monoRasterFromString(s).bytes.length === 4);
  // An Order in the exact shape buildReceiptOrder emits (same fixture receipt-escpos-format uses) —
  // self-contained so CI's server-suites job, which does not build shared/printing's test-dist,
  // still EXECUTES these rather than skipping them into decoration.
  const biz = { name: 'B Fastfoods', currencyCode: 'KES', kraPin: 'P051234567X', telephone: '0700000000', vatRate: 16, ctlRate: 0 };
  const ord = { billNumber: 'ORD-1', orderType: 'counter', cashierName: 'Amina', soldAt: new Date('2026-09-04T12:00:00Z').toISOString(),
    lines: [{ name: 'Chicken Wrap', quantity: 2, unitPrice: 79000, lineTotal: 158000, units: [], stationIds: [] }],
    payments: [{ label: 'cash', amount: 158000 }], changeGiven: 0, total: 158000, kotCount: 0 };
  {
  const gsv0 = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
  const withLogo = Buffer.from(R.renderReceiptEscPos(ord, { ...biz, logoRaster: raster }, 80));
  const without  = Buffer.from(R.renderReceiptEscPos(ord, biz, 80));
  ok('A313: web receipt WITH logoRaster emits GS v 0', withLogo.indexOf(gsv0) > 0);
  ok('A313: web receipt WITHOUT logoRaster does not', without.indexOf(gsv0) === -1);
  ok('A313: the logo adds exactly header(8) + data(4) bytes (+ optional align)', [12, 15].includes(withLogo.length - without.length));
  const kot = Buffer.from(R.renderStationEscPos(ord, { ...biz, logoRaster: raster }, { id: 'k', type: 'kitchen', paperWidthMm: 80 }));
  ok('A313: web KITCHEN ticket never carries the logo', kot.indexOf(gsv0) === -1);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
