/**
 * web-receipt-logo-browser.test.mjs — A316: the SHIPPED web bundle, run the way a browser runs it.
 *
 *   node tests/web-receipt-logo-browser.test.mjs
 *
 * Why this exists: A313's executable check loaded escposRenderer.js in Node, where a real Buffer
 * exists, and only asserted the string STARTED with "mono1:16:2:". In a browser there is no Buffer;
 * the bundle's shim fakes only Buffer.from(array), so the logo encoded as "mono1:16:2:255,255,..."
 * and the cloud rejected every Branding save that carried a logo (owner's screen, 2026-09-23), and
 * every web decode (Branding preview, web POS, reprint) returned null — no logo, ever, on the web.
 *
 * So: a child Node with globalThis.Buffer DELETED before the bundle loads (the page's conditions),
 * and the result judged by the CLOUD's own rule, read out of apps/server/src/routes/business.ts —
 * not a copy of it that could drift.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - put Buffer back in shared/printing/src/raster.ts and rebuild the bundle → the first four fail
 *   - leave the child's Buffer in place                                     → "ran with no Buffer" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

// The cloud's acceptance rule, taken from the route itself.
const route = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/business.ts'), 'utf8');
const src = /\/\^mono1:[^\n]*?\$\//.exec(route)?.[0];
ok('found the cloud\'s logo_receipt regex in routes/business.ts', !!src);
const CLOUD = src ? new RegExp(src.slice(1, -1)) : /$^/;
const cloudAccepts = (v) => {
  const m = CLOUD.exec(v); if (!m) return false;
  const w = Number(m[1]), h = Number(m[2]);
  return w >= 1 && w <= 576 && h >= 1 && h <= 1024 && Buffer.from(m[3], 'base64').length === Math.ceil(w / 8) * h;
};

// ── The browser side, in a child with no Buffer ──────────────────────────────
const bundle = pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href;
const child = `
  delete globalThis.Buffer;
  const hadBuffer = typeof Buffer !== 'undefined' && typeof Buffer.alloc === 'function';
  const R = await import(${JSON.stringify(bundle)});
  // What BrandingTab does on "Choose File": RGBA -> mono raster -> stored string.
  const w = 16, h = 2, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { const on = (i / 4) % 3 !== 0; px[i] = px[i+1] = px[i+2] = on ? 0 : 255; px[i+3] = 255; }
  const stored = R.monoRasterToString(R.monoRasterFromRGBA(px, w, h));
  // What the preview, web POS (usePOSData) and reprint do with the stored string.
  const back = R.monoRasterFromString(stored);
  const biz = { name: 'B Fastfoods', currencyCode: 'KES', vatRate: 16, ctlRate: 0 };
  const ord = { billNumber: 'ORD-1', orderType: 'counter', cashierName: 'Amina', soldAt: '2026-09-04T12:00:00.000Z',
    lines: [{ name: 'Chicken Wrap', quantity: 1, unitPrice: 79000, lineTotal: 79000, units: [], stationIds: [] }],
    payments: [{ label: 'cash', amount: 79000 }], changeGiven: 0, total: 79000, kotCount: 0 };
  const bytes = back ? Array.from(R.renderReceiptEscPos(ord, { ...biz, logoRaster: back }, 80)) : [];
  process.stdout.write(JSON.stringify({ hadBuffer, stored, decoded: back && { w: back.width, h: back.height, n: back.bytes.length }, bytes }));
`;
let out = null, err = '';
try {
  out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch (e) { err = String(e.stderr || e.message).split('\n').slice(0, 3).join(' | '); }

ok('the page\'s encode runs in a browser runtime (no throw)', !!out, err);
if (out) {
  ok('the stored string is one the CLOUD accepts — the save no longer 400s', cloudAccepts(out.stored),
    `got ${JSON.stringify(out.stored.slice(0, 48))}`);
  ok('the page\'s decode returns the raster (preview, web POS, reprint)', !!out.decoded && out.decoded.w === 16 && out.decoded.h === 2 && out.decoded.n === 4,
    JSON.stringify(out.decoded));
  const i = Buffer.from(out.bytes).indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
  ok('a web receipt built from the stored logo carries GS v 0 with the right geometry',
    i > 0 && out.bytes[i + 4] === 2 && out.bytes[i + 5] === 0 && out.bytes[i + 6] === 2 && out.bytes[i + 7] === 0,
    `GS v 0 at ${i}`);
  ok('ran with no Buffer (the conditions this test exists for)', out.hadBuffer === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
