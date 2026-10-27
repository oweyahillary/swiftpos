// A571 — barcode labels on the till (Manager › Stock › Labels): the IPC that prints them, on every way out.
//
// Owner, 2026-10-22: "for now i cant tell what my clients will use as their printer or the label size can we do all?"
//
// Drives the REAL compiled dist/main ipc/labels.js (registerLabelHandlers) on a REAL SQLite file (this till's products,
// its Till station printer), electron shimmed. Only the printers are stood in for: the raw transport (what would go to
// IP:9100 or the USB printer) and the Windows-driver page printer keep what they are handed.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/labels-a571.test.mjs
//
//   - TSPL / ZPL: the bytes for each item (its copies in one program) to the label printer's address, this till's price
//     (branch_price over base_price), the business's currency;
//   - ESC/POS: to this till's receipt printer (its Till station) when none is named, GS k per copy;
//   - Windows driver: one HTML page per label, @page the label's size, to the printer chosen;
//   - the keys (menu.edit or inventory.view) and the online licence refuse before anything prints;
//   - setup: the cloud's label settings kept for offline; save sends the business's settings only with menu.edit;
//   - the Stock › Labels tab: only with the online licence and one of the keys (managerNav, type-stripped).
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A571 register entry):
//   - labels:print without requireKey                         → "a person without the keys is refused" fails
//   - printLabels ignoring the receipt station (no fallback)  → "the receipt printer by default" fails
//   - labelProducts using base_price only                     → "this branch's price" fails
//   - managerNav showing Labels without the online licence    → "only with the online licence" fails
//
// A574 (owner, 2026-10-22: "label should contain barcodes"; "i should also be able to set barcode start sequence, number
// of digits i need etc"): an item with no barcode is never printed bar-less. With menu.edit and online, labels:print
// (generate) asks the cloud for exactly those items' codes, writes them into this till's products and prints them; offline
// or without menu.edit those items are left out and named, the rest print. labels:numbering saves the business's
// numbering (menu.edit, through the cloud) and setup shows it.
// A574 mutations (each made, seen to fail, reverted — listed in the A574 register entry):
//   - generateMissingBarcodes ignoring canEdit                  → "without menu.edit: … no cloud call" fails
//   - printLabels without the labelBarcodeProblem skip          → "never bar-less" fails
//   - the generated codes not written into this till's products → "the new codes are this till's" fails
//   - labelProducts listing pump fuel                           → "petrol_station: … fuel is not listed" fails
//   - managerNav showing Labels only to shops                   → "every business type: Stock › Labels" fails
// A574, every business type (owner, 2026-10-23: "let us not forget other business in the tills all this changes should
// also be taking shape on them based on how they operate"): the tab shows, sets up and prints with bars at a restaurant,
// a cafe, a shop, a minimart, a car park, a petrol station (its shop items; pump fuel gets no label) and "other".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.A571_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, A571_TS: '1' } });
  process.exit(r.status ?? 1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a571-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', on() {} }, ipcMain: { handle() {}, on() {} },
  BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e?.message ?? String(e); } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, currency, logged_in_at) VALUES (1, 't', 'u', 'biz-1', 'Duka Bora', 'KES', '2026-10-22T00:00:00Z')`).run();
db.prepare(`INSERT INTO categories (id, name) VALUES ('c1', 'Dairy')`).run();
const addProduct = (id, name, base, branch, barcode, status = 'active') => db.prepare(
  `INSERT INTO products (id, category_id, name, base_price, branch_price, barcode, status) VALUES (?, 'c1', ?, ?, ?, ?, ?)`).run(id, name, base, branch, barcode, status);
addProduct('p-milk', 'Milk 500ml', 60, 65, '2000000000015');
addProduct('p-sugar', 'Sugar 1kg', 189.5, null, 'AB-1234567');
addProduct('p-old', 'Old soap', 50, null, '2000000000022', 'inactive');
db.prepare(`INSERT INTO print_stations (id, name, kind, sort_order, active) VALUES ('st-till', 'Till', 'receipt', 1, 1)`).run();
db.exec(`CREATE TABLE IF NOT EXISTS station_printers (station_id TEXT PRIMARY KEY, target TEXT NOT NULL, paper_width_mm INTEGER NOT NULL DEFAULT 80, updated_at INTEGER NOT NULL)`);
db.prepare(`INSERT INTO station_printers (station_id, target, paper_width_mm, updated_at) VALUES ('st-till', '10.0.0.9:9100', 58, 1)`).run();

const LB = require(path.join(dist, 'ipc', 'labels.js'));
const sent = [];
const pages = [];
LB._setLabelTransport(async (target, bytes) => { sent.push({ target, text: Buffer.from(bytes).toString('latin1'), bytes: [...bytes] }); });
LB._setLabelHtmlPrinter(async (o) => { pages.push(o); return { ok: true }; });

// The context ipc/shared.ts would hand it: the person's keys, the licence, the cloud.
const who = { keys: ['inventory.view'], online: true };
const cloud = { settings: { widthMm: 40, heightMm: 30, gapMm: 3 }, up: true, puts: [], posts: [], numbering: { format: 'EAN13', prefix: '20', start: 1 }, next: ['2000000000039', '2000000000046', '2000000000053'] };
const handlers = {};
LB.registerLabelHandlers({
  handle: (ch, fn) => { handlers[ch] = fn; },
  requireKey: (keys, refusal) => { if (!keys.some((k) => who.keys.includes(k))) throw new Error(refusal); },
  requireOnlineLicence: () => { if (!who.online) throw new Error('This is part of the online licence — ask ZapTill to turn it on for your business.'); },
  manageFetch: async (p, method, body) => {
    if (!cloud.up) throw new Error('No connection to the cloud.');
    // A574: the numbering and the generate route.
    if (p === '/api/products/barcodes/settings') { if (method === 'PUT') { cloud.numPuts = [...(cloud.numPuts ?? []), body]; cloud.numbering = body; } return cloud.numbering; }
    if (p === '/api/products/barcodes/generate') {
      cloud.posts.push({ p, method, body });
      const assigned = body.product_ids.map((id) => { const b = cloud.next.shift(); return { id, name: id, barcode: b }; });
      return { assigned, kept: [], count: assigned.length };
    }
    if (method === 'PUT') { cloud.puts.push(body); return body; }
    return cloud.settings;
  },
});
const call = (ch, payload) => handlers[ch]({}, payload);

console.log('\nA571 — labels on the till\n');

const setup = await call('labels:setup');
ok('setup: the cloud\'s label settings (and kept for offline)', setup.from === 'cloud' && setup.settings.widthMm === 40 && setup.settings.gapMm === 3);
ok('setup: this till\'s active products at this branch\'s price, with their barcodes', JSON.stringify(setup.products.map((p) => [p.id, p.price, p.barcode, p.category]))
  === JSON.stringify([['p-milk', 65, '2000000000015', 'Dairy'], ['p-sugar', 189.5, 'AB-1234567', 'Dairy']]), JSON.stringify(setup.products));
ok('setup: this till\'s receipt printer is offered for the receipt-printer way', setup.receiptPrinter?.target === '10.0.0.9:9100' && setup.receiptPrinter?.paperWidthMm === 58);
cloud.up = false;
const offline = await call('labels:setup');
ok('offline: the settings kept from the last time', offline.from === 'saved' && offline.settings.widthMm === 40);
cloud.up = true;

// TSPL
let r = await call('labels:save', { printer: { path: 'tspl', rawTarget: '192.168.1.50' } });
ok('save: the printer is this till\'s (no cloud write without settings)', r.ok && r.printer.path === 'tspl' && r.cloud === null && cloud.puts.length === 0);
r = await call('labels:print', { items: [{ product_id: 'p-milk', copies: 3 }, { product_id: 'p-sugar', copies: 1 }, { product_id: 'p-old', copies: 5 }, { product_id: 'nope', copies: 2 }] });
ok('TSPL: 4 labels (an inactive or unknown item prints nothing)', r.ok && r.labels === 4, JSON.stringify(r));
ok('TSPL: one send to the printer\'s address', sent.length === 1 && sent[0].target === '192.168.1.50');
const t = sent[0]?.text ?? '';
ok('TSPL: each item one program, its copies on PRINT', (t.match(/SIZE 40 mm, 30 mm\r\nGAP 3 mm, 0 mm/g) ?? []).length === 2 && t.includes('PRINT 1,3\r\n') && t.includes('PRINT 1,1\r\n'));
ok('TSPL: this branch\'s price and the bars', t.includes('"KES 65"') && t.includes('"EAN13"') && t.includes('"200000000001"') && t.includes('"128"') && t.includes('"AB-1234567"'), t);

// ZPL
sent.length = 0;
r = await call('labels:print', { items: [{ product_id: 'p-milk', copies: 2 }], path: 'zpl' });
ok('ZPL: chosen at print time, ^PQ the copies, ^BE the EAN-13', r.ok && sent[0]?.target === '192.168.1.50' && sent[0].text.startsWith('^XA') && sent[0].text.includes('^PQ2') && sent[0].text.includes('^BEN'));

// ESC/POS — the receipt printer, by default the till's Till station printer at its paper width
sent.length = 0;
r = await call('labels:print', { items: [{ product_id: 'p-milk', copies: 2 }], path: 'escpos' });
const e = sent[0]?.bytes ?? [];
const has = (seq) => e.some((_, i) => seq.every((b, k) => e[i + k] === b));
ok('the receipt printer by default: the Till station\'s printer', r.ok && sent[0]?.target === '10.0.0.9:9100', JSON.stringify(r));
ok('ESC/POS: GS k EAN-13 with 12 digits, module width for 58 mm, one cut per copy',
  has([0x1d, 0x6b, 67, 12]) && has([0x1d, 0x77, 3]) && e.filter((b, i) => b === 0x1d && e[i + 1] === 0x56).length === 2);

// Windows driver
pages.length = 0;
await call('labels:save', { printer: { path: 'windows', windowsPrinter: 'Xprinter XP-365B' } });
r = await call('labels:print', { items: [{ product_id: 'p-sugar', copies: 2 }], settings: { widthMm: 50, heightMm: 25 } });
ok('Windows driver: the printer chosen, the page the label\'s size (the screen\'s unsaved size)', r.ok && pages[0]?.deviceName === 'Xprinter XP-365B'
  && pages[0].widthMm === 50 && pages[0].heightMm === 25 && pages[0].html.includes('@page{size:50mm 25mm;margin:0}'));
ok('Windows driver: one page and one SVG per label', (pages[0]?.html.match(/class="zt-page"/g) ?? []).length === 2 && (pages[0]?.html.match(/<svg/g) ?? []).length === 2);

// A printer fault is an answer, not a crash
LB._setLabelTransport(async () => { throw new Error('connect ECONNREFUSED 192.168.1.50:9100'); });
await call('labels:save', { printer: { path: 'tspl', rawTarget: '192.168.1.50' } });
r = await call('labels:print', { items: [{ product_id: 'p-milk', copies: 1 }] });
ok('a printer that does not answer: said, nothing thrown', r.ok === false && /ECONNREFUSED/.test(r.error));
LB._setLabelTransport(async (target, bytes) => { sent.push({ target, text: Buffer.from(bytes).toString('latin1'), bytes: [...bytes] }); });

// Keys and licence
who.keys = ['orders.create'];
ok('a person without the keys is refused', /does not print labels/.test(await rejects(call('labels:print', { items: [{ product_id: 'p-milk', copies: 1 }] })) ?? ''));
ok('…and cannot open the setup', /does not print labels/.test(await rejects(call('labels:setup')) ?? ''));
who.keys = ['inventory.view']; who.online = false;
ok('without the online licence: refused', /online licence/.test(await rejects(call('labels:print', { items: [{ product_id: 'p-milk', copies: 1 }] })) ?? ''));
who.online = true;

// The business's settings reach the cloud only with menu.edit
r = await call('labels:save', { settings: { widthMm: 58, heightMm: 40 } });
ok('inventory.view only: settings kept on this till, not sent to the cloud', r.cloud === 'not-allowed' && cloud.puts.length === 0 && r.settings.widthMm === 58);
ok('the IPC channels are validated (ipcSchemas) and registered (ipcHandlers), the preload exposes them',
  read('src/main/ipcSchemas.ts').includes("'labels:print':") && read('src/main/ipcHandlers.ts').includes('registerLabelHandlers(ctx)')
  && read('src/main/preload.ts').includes("ipcRenderer.invoke('labels:print', body)"));

// ── A574: every label carries a barcode ──────────────────────────────────────
console.log('\nA574 — never a label without bars; missing codes generated first\n');
addProduct('p-bread', 'Bread', 60, null, null);
addProduct('p-eggs', 'Eggs', 15, null, '  ');
addProduct('p-cafe', 'Cafe latte', 300, null, 'Caf\u00e9');
LB._setLabelTransport(async (target, bytes) => { sent.push({ target, text: Buffer.from(bytes).toString('latin1'), bytes: [...bytes] }); });
await call('labels:save', { printer: { path: 'tspl', rawTarget: '192.168.1.50' } });
const programs = (txt) => (txt.match(/SIZE /g) ?? []).length;
const barcodeOf = (id) => db.prepare(`SELECT barcode FROM products WHERE id = ?`).get(id).barcode;

// Without menu.edit (nobody signed in with it): those items are left out and named; the rest print; no cloud call.
who.keys = ['inventory.view'];
sent.length = 0; cloud.posts.length = 0;
r = await call('labels:print', { items: [{ product_id: 'p-milk', copies: 1 }, { product_id: 'p-bread', copies: 2 }, { product_id: 'p-cafe', copies: 1 }], generate: true });
ok('without menu.edit: Milk prints, Bread is left out (ask a manager), no cloud call', r.ok && r.labels === 1 && cloud.posts.length === 0
  && r.skipped?.some((s) => s.id === 'p-bread' && /ask a manager/.test(s.reason)), JSON.stringify(r));
ok('…and a barcode that cannot be drawn is left out too, said why', r.skipped?.some((s) => s.id === 'p-cafe' && /cannot be drawn/.test(s.reason)));
ok('…the notice names them in plain words', /ask a manager to generate barcodes for these\): Bread\./.test(r.notice ?? '') && /Cafe latte/.test(r.notice ?? ''), r.notice);
ok('never bar-less: one TSPL program, with its BARCODE', sent.length === 1 && programs(sent[0].text) === 1 && (sent[0].text.match(/BARCODE /g) ?? []).length === 1, sent[0]?.text);

// Signed in with menu.edit, but offline: left out with the reason; the rest print.
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, permissions, token, logged_in_at)
  VALUES (1, 's1', 'Max', 'Manager', 'b1', '{"menu.edit":true,"inventory.view":true}', 'tok', '2026-10-22T00:00:00Z')`).run();
who.keys = ['menu.edit', 'inventory.view'];
cloud.up = false; sent.length = 0;
r = await call('labels:print', { items: [{ product_id: 'p-milk', copies: 1 }, { product_id: 'p-bread', copies: 1 }], generate: true });
ok('offline: Bread left out (barcodes could not be generated - no connection), Milk prints', r.ok && r.labels === 1
  && r.skipped?.length === 1 && /could not be generated - No connection to the cloud/.test(r.skipped[0].reason) && barcodeOf('p-bread') === null, JSON.stringify(r));
r = await call('labels:print', { items: [{ product_id: 'p-bread', copies: 1 }], generate: true, path: 'escpos' });
ok('offline, only items without a barcode: nothing sent, the answer says why', r.ok === false && r.labels === 0 && /No labels printed/.test(r.error ?? '') && sent.length === 1, JSON.stringify(r));
pages.length = 0;
r = await call('labels:print', { items: [{ product_id: 'p-eggs', copies: 1 }], generate: true, path: 'windows' });
ok('…the Windows-driver way too: no page printed', r.ok === false && pages.length === 0, JSON.stringify(r));
cloud.up = true;

// Online, menu.edit, not asked to generate (the screen asks first): left out.
r = await call('labels:print', { items: [{ product_id: 'p-bread', copies: 1 }] });
ok('not asked to generate: left out (no barcode yet), no cloud call', r.ok === false && cloud.posts.length === 0 && /no barcode yet/.test(r.notice ?? ''), JSON.stringify(r));

// Online, menu.edit, asked: the cloud generates for exactly those items, the till keeps the codes, all print.
sent.length = 0;
r = await call('labels:print', { items: [{ product_id: 'p-milk', copies: 1 }, { product_id: 'p-bread', copies: 2 }, { product_id: 'p-eggs', copies: 1 }, { product_id: 'p-cafe', copies: 1 }], generate: true });
ok('generate via the cloud for exactly the items without a barcode (not Milk, not the undrawable one)', cloud.posts.length === 1
  && cloud.posts[0].method === 'POST' && JSON.stringify(cloud.posts[0].body) === JSON.stringify({ product_ids: ['p-bread', 'p-eggs'] }), JSON.stringify(cloud.posts));
ok('the new codes are this till\'s products now, and in the answer', barcodeOf('p-bread') === '2000000000039' && barcodeOf('p-eggs') === '2000000000046'
  && JSON.stringify(r.generated) === JSON.stringify([{ id: 'p-bread', barcode: '2000000000039' }, { id: 'p-eggs', barcode: '2000000000046' }]), JSON.stringify(r));
ok('they print with their bars: Milk, Bread ×2, Eggs (Cafe latte still left out)', r.ok && r.labels === 4 && programs(sent[0]?.text ?? '') === 3
  && (sent[0]?.text.match(/BARCODE /g) ?? []).length === 3 && sent[0].text.includes('"200000000003"') && sent[0].text.includes('"200000000004"') && r.skipped?.length === 1, JSON.stringify(r));
const again = await call('labels:setup');
ok('setup lists them with their codes (offline-ready)', again.products.find((p) => p.id === 'p-bread')?.barcode === '2000000000039' && again.barcodes.includes('2000000000046'));

// The numbering: from the cloud on setup; saved with menu.edit; refused without; offline not saved.
cloud.numbering = { format: 'CODE128N', prefix: '77', length: 8, start: 5, checkDigit: false };
const s2 = await call('labels:setup');
ok('setup: the business\'s numbering from the cloud, and whether this person may generate', s2.numbering.format === 'CODE128N' && s2.numbering.prefix === '77' && s2.canGenerate === true);
r = await call('labels:numbering', { numbering: { format: 'EAN8', prefix: '2x9', start: 3 } });
ok('labels:numbering: saved cleaned through the cloud (PUT /api/products/barcodes/settings)', r.ok && JSON.stringify(cloud.numPuts?.at(-1)) === JSON.stringify({ format: 'EAN8', prefix: '29', start: 3, length: 8, checkDigit: true }), JSON.stringify(r));
cloud.up = false;
const kept = await call('labels:setup');
ok('offline: the numbering kept from the last time', kept.numbering.format === 'EAN8' && kept.numbering.prefix === '29');
r = await call('labels:numbering', { numbering: { format: 'UPCA', prefix: '4' } });
ok('offline: the numbering is not saved, said so', r.ok === false && /Not saved/.test(r.error ?? '') && r.numbering.format === 'EAN8');
cloud.up = true;
who.keys = ['inventory.view'];
ok('without menu.edit: the numbering cannot be changed', /right to edit products/.test(await rejects(call('labels:numbering', { numbering: { prefix: '21' } })) ?? ''));
who.keys = ['inventory.view'];
const tab = read('src/renderer/components/LabelsTab.tsx');
ok('the Labels tab asks before generating, sends generate, and has no Barcode switch', tab.includes("no barcode yet — generate ${n === 1 ? 'it' : 'them'} and print?")
  && tab.includes('settings, generate });') && !tab.includes("['showBarcode',") && tab.includes('data-testid="barcode-numbering"'));
ok('the channel is validated and exposed', read('src/main/ipcSchemas.ts').includes("'labels:numbering':") && read('src/main/preload.ts').includes("ipcRenderer.invoke('labels:numbering'")
  && read('src/main/ipcSchemas.ts').includes("generate: { t: 'boolean', optional: true }"));

// The tab
const N = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'managerNav.ts')).href);
const base = { isRestaurant: false, canOverview: true, canOrders: true, canItems: true, canShifts: true, canExpenses: true, canCloseDay: true,
  canMenu: true, canOffers: true, canSettings: true, canPrinting: true, canStaff: true, showStock: true };
const tabs = (a) => N.buildManagerNav({ ...base, ...a }).flatMap((g) => g.tabs.map((x) => `${g.key}/${x.key}`));
ok('Stock › Labels with the online licence and a key', tabs({ online: true, canLabels: true }).includes('stock/labels'));
ok('only with the online licence', !tabs({ online: false, canLabels: true }).includes('stock/labels'));
ok('only with a key', !tabs({ online: true, canLabels: false }).includes('stock/labels'));
ok('ManagerPage shows the tab (menu.edit or inventory.view)', read('src/renderer/pages/ManagerPage.tsx').includes("canLabels: hasAny('menu.edit', 'inventory.view')")
  && read('src/renderer/pages/ManagerPage.tsx').includes("case 'labels': return online ? <LabelsTab />"));

// ── A574: every business type ────────────────────────────────────────────────
console.log('\nA574 — the Labels tab at every business type\n');
const T = await import(pathToFileURL(path.join(here, '..', '..', '..', 'packages', 'core', 'src', 'businessTerms.ts')).href);
const W = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'labelsWords.ts')).href);
db.prepare(`INSERT INTO device_config (id, deploy_mode, server_url, business_type, configured, created_at, updated_at)
  VALUES (1, 'cloud', 'http://x', 'retail', 1, '2026-10-23', '2026-10-23')
  ON CONFLICT(id) DO UPDATE SET business_type = excluded.business_type`).run();
addProduct('p-fuel', 'Diesel', 180, null, null);
db.prepare(`UPDATE products SET is_fuel = 1 WHERE id = 'p-fuel'`).run();
addProduct('p-oil', 'Engine oil 1L', 950, null, '5901234123457');
addProduct('p-soda', 'Soda 500ml (take-away)', 80, null, '036000291452');
who.keys = ['menu.edit', 'inventory.view']; who.online = true; cloud.up = true;
await call('labels:save', { printer: { path: 'zpl', rawTarget: '192.168.1.60' } });
for (const mode of T.BUSINESS_TYPE_KEYS) {
  db.prepare(`UPDATE device_config SET business_type = ? WHERE id = 1`).run(mode);
  const words = T.businessTerms(mode);
  const nav = N.relabelCatalogue(N.buildManagerNav({ ...base, isRestaurant: words.food, online: true, canLabels: true, showStock: mode !== 'parking' }), words.catalogue);
  const shown = nav.flatMap((g) => g.tabs.map((x) => `${g.key}/${x.key}`)).includes('stock/labels');
  const s = await call('labels:setup');
  sent.length = 0;
  const item = mode === 'petrol_station' ? 'p-oil' : words.food ? 'p-soda' : 'p-milk';
  const pr = await call('labels:print', { items: [{ product_id: item, copies: 2 }] });
  ok(`${mode}: every business type: Stock › Labels shows (the catalogue called "${words.catalogue}")`, shown && nav.some((g) => g.key === 'menu' && g.label === words.catalogue));
  ok(`${mode}: setup knows the type, prints ${item} with its bars (ZPL ^B…)`, s.business.type === mode && pr.ok && pr.labels === 2
    && /\^B(E|U)N/.test(sent[0]?.text ?? ''), JSON.stringify(pr));
  ok(`${mode}: the tab says what labels are for here`, typeof W.labelsIntro(mode) === 'string' && W.labelsIntro(mode).length > 20);
}
db.prepare(`UPDATE device_config SET business_type = 'petrol_station' WHERE id = 1`).run();
const petrol = await call('labels:setup');
ok('petrol_station: the shop items are listed, pump fuel is not listed (no label at the pump)', petrol.products.some((p) => p.id === 'p-oil') && !petrol.products.some((p) => p.id === 'p-fuel'));
ok('petrol_station / restaurant / shop / parking: the intro is in their words', /Pump fuel/.test(W.labelsIntro('petrol_station')) && /grab-and-go/.test(W.labelsIntro('restaurant'))
  && /grab-and-go/.test(W.labelsIntro('cafe')) && /shelf/.test(W.labelsIntro('retail')) && /parking/.test(W.labelsIntro('parking')));
ok('the tab reads the type for its words (intro, search)', read('src/renderer/components/LabelsTab.tsx').includes('{labelsIntro(setup.business.type)}')
  && read('src/renderer/components/LabelsTab.tsx').includes('businessTerms(setup.business.type).products'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
