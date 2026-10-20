/**
 * a534-update-state-receipt.test.mjs — A534 (2026-10-20), the cloud and web halves of four small 1.0.20 items.
 * Owner: "add all of them since effort is small".
 *
 *   node tests/a534-update-state-receipt.test.mjs        (needs apps/dashboard's npm ci: esbuild, react, react-dom)
 *
 *   - "why isn't this till updating?": a till's update report is cleaned before it is stored (lib/updateState.ts), taken
 *     only from a till's own session (routes/desktopUpdate.ts POST /state, a TILL write in lib/terminalWrites.ts), and
 *     returned only to ZapTill (GET /api/admin/clients/:id/devices, requireAdmin — no client route selects it); the
 *     status answer says reportsState so a 1.0.20 till knows this cloud takes it.
 *   - the admin portal's line per till (apps/admin/src/desktopVersions.ts tillUpdateLine): each reported state, the
 *     version-only hints for tills older than 1.0.20, "Last seen 3 days ago" for a silent till.
 *   - the browser-printed (Windows / non-thermal) web POS receipt: the compact layout A530 gave the thermal receipt,
 *     and every line as before with the client's receipt_classic_layout switch — the REAL ReceiptView rendered.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
 *   - cleanUpdateState keeping a percent outside a download                   → "percent only while downloading" fails
 *   - tillUpdateLine without the 1.0.16 branch (every old till "installs itself") → "older than 1.0.16" fails
 *   - tillUpdateLine without the silent check                                  → "Last seen 3 days ago" fails
 *   - ReceiptView compact = classic (always the old layout)                    → "compact: one line for date and order" fails
 *   - PaymentModal not passing classic                                         → its source pin fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const U = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/updateState.ts')).href);
const V = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/desktopVersions.ts')).href);
const T = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/terminalWrites.ts')).href);

console.log('\nA534 — the update state, the admin line, the browser receipt\n');

// ── The update state as the cloud stores it ─────────────────────────────────────────────────────────────────────────
await ok('a report is cleaned: known state, versions checked, error cut to 160, unknown fields dropped', () => {
  const c = U.cleanUpdateState({ running: '1.0.19', state: 'error', version: '1.0.20', percent: 50, since: '2026-10-20T14:10:00Z',
    checked_at: 'not a date', approved: '1.0.20', error: 'x'.repeat(400), idle_note: null, task: true, secret: 'nope' });
  assert.equal(c.state, 'error'); assert.equal(c.running, '1.0.19'); assert.equal(c.version, '1.0.20');
  assert.equal(c.error.length, 160); assert.equal(c.checked_at, null); assert.equal(c.since, '2026-10-20T14:10:00.000Z');
  assert.equal(c.task, true); assert.ok(!('secret' in c));
});
await ok('percent only while downloading (0-100); no state → not a report; a bad version → null', () => {
  assert.equal(U.cleanUpdateState({ state: 'downloading', percent: 145.6 }).percent, 100);
  assert.equal(U.cleanUpdateState({ state: 'downloaded', percent: 100 }).percent, null);
  assert.equal(U.cleanUpdateState({ state: 'hacked' }), null);
  assert.equal(U.cleanUpdateState(null), null);
  assert.equal(U.cleanUpdateState({ state: 'idle', running: '1.0.19; drop table' }).running, null);
});
await ok('the cloud takes it from a till\'s OWN session only, for its own row — a TILL write, never a person\'s page', () => {
  const r = read('apps/server/src/routes/desktopUpdate.ts');
  assert.match(r, /router\.post\('\/state'[\s\S]{0,200}if \(!req\.isTill \|\| !req\.deviceId\)/);
  assert.match(r, /\.eq\('business_id', req\.businessId\)\s*\.eq\('device_id', req\.deviceId\)/);
  assert.match(r, /reportsState: true/);
  assert.equal(T.terminalWriteVerdict('desktop', 'POST', '/api/desktop-update/state', false), 'till');
});
await ok('returned to ZapTill only: the admin devices route (requireAdmin) — no other route reads update_state', () => {
  const admin = read('apps/server/src/routes/admin.ts');
  assert.match(admin, /router\.get\('\/clients\/:id\/devices', requireAdmin,[\s\S]{0,2500}update_state, update_state_at/);
  const dir = path.join(ROOT, 'apps/server/src/routes');
  const readers = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && /update_state/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(readers.sort(), ['admin.ts', 'desktopUpdate.ts'], `routes naming update_state: ${readers}`);
  assert.doesNotMatch(read('apps/server/src/routes/desktopUpdate.ts'), /select\([^)]*update_state/);
  const adminAuth = read('apps/server/src/middleware/adminAuth.ts');
  assert.match(adminAuth, /role: 'super_admin' \| 'agent'/);
});

// ── The admin portal's line ─────────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-20T15:00:00Z');
const at = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fresh = { lastSyncAt: '2026-10-20T14:55:00Z', lastSeenAt: '2026-10-20T08:00:00Z' };
const line = (row, approved = '1.0.21') => V.tillUpdateLine(row, approved, NOW);
await ok('up to date: "Up to date"', () => {
  assert.deepEqual(line({ ...fresh, appVersion: '1.0.21' }), { text: 'Up to date', tone: 'ok' });
});
await ok('each reported state, in words', () => {
  const r = (s) => line({ ...fresh, appVersion: '1.0.20', updateStateAt: '2026-10-20T14:58:00Z', updateState: { running: '1.0.20', ...s } }).text;
  assert.equal(r({ state: 'downloading', version: '1.0.21', percent: 45 }), 'Downloading 1.0.21 (45%)');
  assert.equal(r({ state: 'downloaded', version: '1.0.21', since: '2026-10-20T14:02:00Z' }), `Downloaded — installs when ZapTill is next closed (waiting since ${at('2026-10-20T14:02:00Z')})`);
  assert.equal(r({ state: 'error', error: 'net::ERR_CONNECTION_RESET', since: '2026-10-20T14:10:00Z' }), `Update failed: net::ERR_CONNECTION_RESET (at ${at('2026-10-20T14:10:00Z')})`);
  assert.match(r({ state: 'idle', approved: '1.0.21', checked_at: '2026-10-20T14:00:00Z' }), /^Waiting to download 1\.0\.21 \(last checked/);
  assert.match(r({ state: 'idle', approved: '1.0.19' }), /^Not told about 1\.0\.21 yet \(it last heard 1\.0\.19/);
});
await ok('a till older than 1.0.20 reports nothing: a hint from its version alone', () => {
  assert.equal(line({ ...fresh, appVersion: '1.0.5' }).text,
    'Not checking — this till is older than 1.0.16: close ZapTill fully and reopen it; accept the Windows prompt');
  assert.equal(line({ ...fresh, appVersion: '1.0.15' }).tone, 'warn');
  assert.equal(line({ ...fresh, appVersion: '1.0.16' }).text, 'Installs itself when idle — if stuck, close and reopen ZapTill');
  assert.equal(line({ ...fresh, appVersion: '1.0.19' }).text, 'Installs itself when idle — if stuck, close and reopen ZapTill');
});
await ok('a silent till: "Last seen 3 days ago" (with its hint), never seen: "Never seen"', () => {
  const old = { lastSyncAt: '2026-10-17T15:00:00Z', lastSeenAt: '2026-10-17T09:00:00Z' };
  assert.match(line({ ...old, appVersion: '1.0.5' }).text, /^Last seen 3 days ago · Not checking/);
  assert.equal(line({ ...old, appVersion: '1.0.20', updateStateAt: '2026-10-17T15:00:00Z', updateState: { running: '1.0.20', state: 'downloading', percent: 10 } }).text,
    'Last seen 3 days ago · Downloading 1.0.21 (10%)');
  assert.equal(line({ appVersion: '1.0.20' }).text, 'Never seen');
});
await ok('the card shows the line per till', () => {
  const p = read('apps/admin/src/AdminPortal.tsx');
  assert.match(p, /const u = tillUpdateLine\(dv, detail\?\.desktop_approved_version\);/);
  assert.match(p, /data-testid="till-update-line"/);
});

// ── The browser-printed receipt (web POS ReceiptView) ───────────────────────────────────────────────────────────────
function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`${name} not installed (npm ci in apps/dashboard)`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a534-receipt-'));
const entry = path.join(tmp, 'entry.tsx');
fs.writeFileSync(entry, `import { renderToStaticMarkup } from 'react-dom/server';
import ReceiptView from ${JSON.stringify(path.join(ROOT, 'apps/dashboard/src/pages/pos/ReceiptView.tsx').replace(/\\/g, '/'))};
export const render = (p: any) => renderToStaticMarkup(<ReceiptView {...p} />);`);
const out = path.join(tmp, 'receipt.cjs');
esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', jsx: 'automatic', outfile: out, logLevel: 'silent',
  nodePaths: [path.join(ROOT, 'apps/dashboard/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
const R = createRequire(import.meta.url)(out);
const text = (html) => html.replace(/<[^>]+>/g, '\n').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').split('\n').map((s) => s.trim()).filter(Boolean);
const rules = (html) => (html.match(/border-top:1px dashed #000/g) ?? []).length;
const sale = {
  business: { id: 'b', name: 'B Foods', phone: '0712 345678', tax_pin: 'P051234567X', address: 'Juja', vat_rate: 16 },
  orderNumber: 'W-1042', total: 1250, subtotal: 1250, vatAmount: 172.41, currency: 'KES',
  cart: [{ product: { id: 'p1', name: 'Burger' }, quantity: 1, unitPrice: 750, lineTotal: 750, selectedVariants: [], selectedModifiers: [] },
         { product: { id: 'p2', name: 'Juice' }, quantity: 1, unitPrice: 500, lineTotal: 500, selectedVariants: [], selectedModifiers: [] }],
  payments: [{ method: 'cash', amount: 1250 }], tendered: 1300, change: 50,
};
await ok('compact (the standard): one line for date and order, one for phone and PIN, no Subtotal = Total, the cash line carries the tendered', () => {
  const t = text(R.render(sale));
  assert.ok(t.some((l) => /· Order: W-1042$/.test(l)), t.join(' | '));
  assert.ok(t.includes('Tel: 0712 345678 · PIN: P051234567X'), t.join(' | '));
  assert.ok(!t.includes('Subtotal'), 'Subtotal printed with no discount');
  assert.ok(!t.includes('Payment') && !t.includes('Tendered'), t.join(' | '));
  const i = t.indexOf('CASH'); assert.equal(t[i + 1], 'KES 1,300.00'); assert.equal(t[t.indexOf('Change') + 1], 'KES 50.00');
  assert.ok(!t.some((l) => l.startsWith('VAT Reg:')), 'the PIN printed twice');
  assert.equal(rules(R.render(sale)), 4, 'dashed rules');
});
await ok('compact keeps what carries money: a discount brings the Subtotal back; tip → TOTAL PAID; split without its heading', () => {
  const t = text(R.render({ ...sale, promoDiscount: 125, promoName: 'Happy hour', total: 1125, tip: 100,
    payments: [{ method: 'cash', amount: 600 }, { method: 'mpesa', amount: 625, reference: 'QK12' }] }));
  assert.ok(t.includes('Subtotal') && t.includes('Happy hour') && t.includes('TOTAL PAID'), t.join(' | '));
  assert.ok(!t.includes('Split payment') && t.includes('M-PESA'), t.join(' | '));
});
await ok('classic (receipt_classic_layout): every line as before', () => {
  const html = R.render({ ...sale, classic: true });
  const t = text(html);
  for (const want of ['Tel: 0712 345678', 'PIN: P051234567X', 'Order: W-1042', 'Subtotal', 'Payment', 'Tendered', 'VAT Reg: P051234567X']) assert.ok(t.includes(want), `${want} missing: ${t.join(' | ')}`);
  assert.equal(rules(html), 5, 'dashed rules (the doubled one too)');
});
await ok('the web POS hands the client\'s switch to the receipt', () => {
  assert.match(read('apps/dashboard/src/pages/pos/PaymentModal.tsx'), /classic=\{posFeatures\?\.receipt_classic_layout === true\}/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
