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
 *     A538 (owner, 2026-10-21: "go back to the old layout"): turned round — every line as before is the standard, the
 *     compact lines only with receipt_compact_layout (`compact`). Mutations (A538): ReceiptView's default back to
 *     compact → "the standard … classic layout" fails; PaymentModal passing the old switch → its source pin fails.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
 *   - cleanUpdateState keeping a percent outside a download                   → "percent only while downloading" fails
 *   - tillUpdateLine without the 1.0.16 branch (every old till "installs itself") → "older than 1.0.16" fails
 *   - tillUpdateLine without the silent check                                  → "Last seen 3 days ago" fails
 *   - ReceiptView compact = classic (always the old layout)                    → "compact: one line for date and order" fails
 *   - PaymentModal not passing classic                                         → its source pin fails
 *
 * A547 (owner, 2026-10-21: "you can also finish the leftovers"): the classic (standard) browser receipt's payment block
 * is the thermal receipt's A539 block — "Payment Details: <Buy Goods|Paybill> - <number>" (bold), a rule, the payments
 * (a lone cash payment carries the tendered), CHANGE when there is some, no separate till line; "Round Off" only when
 * it is not 0.00 (A540); the compact opt-in keeps its own block. Mutations (A547, each red on its own): the heading
 * without the number → "A547: the classic payment block"; the rule under the heading removed → same; Round Off shown at
 * 0 → "A547: Round Off"; the compact path given the heading → "A547: compact keeps its block"; PaymentModal not passing
 * `pay` → "the web POS hands …".
 *
 * A551 (owner, 2026-10-21, on paper: "we just write `PAY BILL/BUY GOODS:` newline `123445` and we center it and increase
 * the font size and thickness, We remove the wordings payment details"; "why not write `Chicken burger - Spicy`"): the
 * classic block is the label alone ("BUY GOODS:"), the number, centred, large and bold (a Paybill's account under them),
 * a rule, the payments; no number, no heading; a variant on the item's own line. Mutations (A551, each red on its own):
 * the "Payment Details" words back → "A551: the classic payment block"; not centred → same; the account not split off →
 * same; a heading with no number → "A538: the standard"; the variants as rows again → "A551: a variant".
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
  // A554: the admin portal's Pull logs card (logRequestsAdmin.ts, every route requireAdmin) reads ONE field of it —
  // log_pull, whether the till answers a pull — and returns only that yes/no (can_answer), never the state itself.
  assert.deepEqual(readers.sort(), ['admin.ts', 'desktopUpdate.ts', 'logRequestsAdmin.ts'], `routes naming update_state: ${readers}`);
  const lr = read('apps/server/src/routes/logRequestsAdmin.ts');
  assert.equal((lr.match(/router\.(get|post)\(/g) || []).length, (lr.match(/router\.(get|post)\('[^']+', requireAdmin,/g) || []).length, 'every log-requests route is admin-only');
  assert.match(lr, /r\.update_state && r\.update_state\.log_pull === true\) get\(r\.device_id\)\.reportsLogPull = true;/);
  assert.equal((lr.match(/update_state/g) || []).length, 4, 'update_state named only where log_pull is read');
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
// A538 (owner, 2026-10-21: "go back to the old layout"): the classic layout is the standard again; compact needs the
// client's receipt_compact_layout switch (the `compact` prop). `classic` (A534's prop) is gone and changes nothing.
await ok('A538: compact (receipt_compact_layout, opt-in): one line for date and order, one for phone and PIN, no Subtotal = Total, the cash line carries the tendered', () => {
  const t = text(R.render({ ...sale, compact: true }));
  assert.ok(t.some((l) => /· Order: W-1042$/.test(l)), t.join(' | '));
  assert.ok(t.includes('Tel: 0712 345678 · PIN: P051234567X'), t.join(' | '));
  assert.ok(!t.includes('Subtotal'), 'Subtotal printed with no discount');
  assert.ok(!t.includes('Payment') && !t.includes('Tendered'), t.join(' | '));
  const i = t.indexOf('CASH'); assert.equal(t[i + 1], 'KES 1,300.00'); assert.equal(t[t.indexOf('Change') + 1], 'KES 50.00');
  assert.ok(!t.some((l) => l.startsWith('VAT Reg:')), 'the PIN printed twice');
  assert.equal(rules(R.render({ ...sale, compact: true })), 4, 'dashed rules');
});
await ok('compact keeps what carries money: a discount brings the Subtotal back; tip → TOTAL PAID; split without its heading', () => {
  const t = text(R.render({ ...sale, compact: true, promoDiscount: 125, promoName: 'Happy hour', total: 1125, tip: 100,
    payments: [{ method: 'cash', amount: 600 }, { method: 'mpesa', amount: 625, reference: 'QK12' }] }));
  assert.ok(t.includes('Subtotal') && t.includes('Happy hour') && t.includes('TOTAL PAID'), t.join(' | '));
  assert.ok(!t.includes('Split payment') && t.includes('M-PESA'), t.join(' | '));
});
await ok('A538: the standard (no switch) is the classic layout — every line as before', () => {
  for (const html of [R.render(sale), R.render({ ...sale, compact: false }), R.render({ ...sale, classic: true })]) {
    const t = text(html);
    // A551: no till number here — no heading at all (and no rule of its own); never the words "Payment Details".
    for (const want of ['Tel: 0712 345678', 'PIN: P051234567X', 'Order: W-1042', 'Subtotal', 'CASH', 'CHANGE', 'VAT Reg: P051234567X']) assert.ok(t.includes(want), `${want} missing: ${t.join(' | ')}`);
    assert.ok(!t.some((l) => /payment details/i.test(l)) && !html.includes('data-testid="payment-details"'), t.join(' | '));
    assert.ok(!t.some((l) => /· Order: W-1042$/.test(l)), 'date and order on one line (compact) on the standard');
    assert.equal(rules(html), 5, 'dashed rules (the doubled one; none under a heading that is not there)');
  }
  assert.equal(R.render({ ...sale, classic: true }), R.render(sale), 'A534\'s `classic` prop changes nothing now');
});
// ── A551: the classic payment block as the thermal receipt prints it, no zero round off (A540) ─────────────────────
await ok('A551: the classic payment block — "BUY GOODS:", the number (centred, large, bold), a rule, the payments, CHANGE', () => {
  const html = R.render({ ...sale, pay: { label: 'Buy Goods', number: '892984' } });
  const t = text(html);
  const i = t.indexOf('BUY GOODS:');
  assert.ok(i >= 0 && t[i + 1] === '892984', t.join(' | '));
  assert.deepEqual(t.slice(i + 2, i + 6), ['CASH', 'KES 1,300.00', 'CHANGE', 'KES 50.00'], t.join(' | '));
  assert.ok(!t.some((l) => /payment details/i.test(l)), 'the words "Payment Details" are gone');
  // In the markup: a centred bold block, the label and the number larger than the receipt's 12px, then a rule, then CASH.
  assert.match(html, /<div style="text-align:center;font-weight:bold;margin-bottom:3px" data-testid="payment-details"><p style="font-size:16px">BUY GOODS:<\/p><p style="font-size:18px">892984<\/p><\/div>/);
  const h = html.indexOf('data-testid="payment-details"');
  const ruleAt = html.indexOf('border-top:1px dashed #000', h), cashAt = html.indexOf('>CASH<', h);
  assert.ok(h > 0 && ruleAt > h && ruleAt < cashAt, 'the rule sits between the block and the payments');
  assert.ok(!t.some((l) => /^Buy Goods:|^Paybill:/.test(l)), 'a separate till line after the payments');
  assert.ok(!t.includes('Payment') && !t.includes('Tendered') && !t.includes('Split payment'), t.join(' | '));
  // A Paybill with its account, as A450 stores it: the label, the number, then "Account: WEST1" in the normal weight.
  const pb = R.render({ ...sale, pay: { label: 'Paybill', number: '4098201, Account WEST1' } });
  const tp = text(pb);
  assert.deepEqual(tp.slice(tp.indexOf('PAYBILL:'), tp.indexOf('PAYBILL:') + 3), ['PAYBILL:', '4098201', 'Account: WEST1'], tp.join(' | '));
  assert.match(pb, /<p style="font-weight:normal">Account: WEST1<\/p><\/div>/);
  assert.ok(!tp.some((l) => l.includes(', Account')));
  // No number → no heading at all.
  for (const p of [undefined, { label: 'Buy Goods', number: '  ' }]) {
    const x = R.render({ ...sale, pay: p });
    assert.ok(!x.includes('data-testid="payment-details"') && !text(x).includes('BUY GOODS:'), JSON.stringify(p));
  }
});
await ok('A551: a split on the classic receipt — one block, a rule, each payment with its reference; no CHANGE at 0', () => {
  const t = text(R.render({ ...sale, pay: { label: 'Buy Goods', number: '892984' }, change: 0,
    payments: [{ method: 'cash', amount: 600 }, { method: 'mpesa', amount: 650, reference: 'QK12' }] }));
  const i = t.indexOf('892984');
  assert.deepEqual(t.slice(i + 1, i + 7), ['CASH', 'KES 600.00', 'M-PESA', 'KES 650.00', 'Ref', 'QK12'], t.join(' | '));
  assert.ok(!t.includes('CHANGE') && !t.includes('Split payment'), t.join(' | '));
});
await ok('A551: a variant on the item\'s own line — "Chicken Burger - Spicy x1", no "Spice: …" row; a modifier keeps its row', () => {
  const cart = [{ product: { id: 'p1', name: 'Chicken Burger' }, quantity: 1, unitPrice: 650, lineTotal: 650,
    selectedVariants: [{ groupId: 'g', groupName: 'Spice', optionId: 'o', optionName: 'Chicken Burger Spicy', priceAdjustment: 0 }],
    selectedModifiers: [{ groupId: 'm', groupName: 'Extras', optionId: 'x', optionName: 'Extra Cheese', price: 50 }] },
    { product: { id: 'p2', name: 'Beef Burger' }, quantity: 2, unitPrice: 800, lineTotal: 1600,
      selectedVariants: [{ groupId: 'g2', groupName: 'Size', optionId: 'l', optionName: 'Large', priceAdjustment: 100 }], selectedModifiers: [] }];
  const t = text(R.render({ ...sale, cart }));
  assert.ok(t.includes('Chicken Burger - Spicy x1') && t.includes('Beef Burger - Large x2'), t.join(' | '));
  assert.ok(!t.some((l) => /^Spice:|^Size:|Chicken Burger Spicy/.test(l)), t.join(' | '));
  assert.ok(t.includes('+ Extra Cheese'), 'the modifier still a row of its own');
});
await ok('A547: Round Off — hidden at 0.00 (A540), shown when the cent is really there', () => {
  assert.ok(!text(R.render(sale)).some((l) => /Round Off/.test(l)));
  assert.ok(!text(R.render({ ...sale, roundOff: 0.001 })).some((l) => /Round Off/.test(l)));
  const t = text(R.render({ ...sale, roundOff: 0.01 }));
  assert.equal(t[t.indexOf('Round Off') + 1], 'KES 0.01', t.join(' | '));
});
await ok('A547: compact keeps its block — no "Payment Details" heading, the method and amount on one line', () => {
  const t = text(R.render({ ...sale, compact: true, pay: { label: 'Buy Goods', number: '892984' } }));
  assert.ok(!t.some((l) => l.startsWith('Payment Details')), t.join(' | '));
  assert.equal(t[t.indexOf('CASH') + 1], 'KES 1,300.00');
});
await ok('the web POS hands the client\'s switch to the receipt', () => {
  const pm = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
  assert.match(pm, /compact=\{posFeatures\?\.receipt_compact_layout === true\}/);
  assert.match(pm, /pay=\{receiptPay\}/);   // A547
  assert.ok(!/receipt_classic_layout/.test(pm), 'the retired switch is not read');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
