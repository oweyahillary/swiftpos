// A606 — the customer screen on a dual-screen POS: a second, frameless, full-screen window on the customer's monitor that
// shows the sale as it is rung up, the payment and "Thank you" — fed by the cashier's POS through main, offline.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/customer-display-a606.test.mjs
//
// Owner, 2026-10-28: "Yesterday I saw a POS with two screens, one facing the client and the other for the cashier."
// STANDARD for every client; PREMIUM: the logo and brand colours (the 'themes' flag, as A597 / A605), the idle slideshow and
// the M-Pesa details (the online licence, web_pos_enabled).
//
//   1  the screen: chosen by the Tech page, numbered left to right; never the cashier's own; the chosen screen unplugged →
//      the window closes quietly with a note, plugged back → it opens again; nothing chosen / one screen → off with a note;
//      "Show test screen" and "Identify displays"; the choice remembered per PC (maintenance_state).
//   2  the state sent: CLEANED in main (a whitelist) — no cost price, staff, PIN, customer or note crosses; idle carries no
//      sale; "Thank you" carries no lines; numbers clamped; the POS page sends only display fields.
//   3  premium gated: no brand / logo without themes; no slideshow and no M-Pesa without the online licence — the gate
//      itself and main's content on REAL SQLite; the slideshow cache: nothing fetched without the licence, each image
//      fetched ONCE (cached by hash, never again on the next pass), a wrong type / too large refused, a removed image
//      deleted, a failed one not asked again within the hour.
//   4  stages: idle → sale → payment → thank you → idle (8 s), the stage's start stamped in main.
//   5  the words by business type: shop items, restaurant order + table, petrol litres and price per litre, weighed kg —
//      the REAL view rendered (react-dom/server).
//   6  the bundle: the customer screen page is its own chunk, never in the POS's main chunk (≤ 452 kB still holds).
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A606 report):
//   - customerScreen.ts sanitiseDisplayState copying the raw line (…l) instead of the whitelist → 2 "no cost price" fails
//   - customerScreen.ts pickScreen allowing the primary screen                                    → 1 "never the cashier's" fails
//   - customerScreen.ts gateDisplayContent without the licence on the M-Pesa                       → 3 "no M-Pesa" fails
//   - customerSlides.ts sync without the `fileFor(key)` check (fetches every pass)                → 3 "fetched ONCE" fails
//   - main.tsx importing CustomerDisplayPage statically                                           → 6 "own chunk" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a606-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.22', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }), on() {} }, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }, net: { isOnline: () => true }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const CS = require(path.join(dist, 'customerScreen.js'));
const CD = require(path.join(dist, 'customerDisplay.js'));
const SL = require(path.join(dist, 'customerSlides.js'));

// The REAL view, bundled for Node and rendered to HTML (no browser).
const entry = path.join(userData, 'entry.tsx');
fs.writeFileSync(entry, `export { default as View } from ${JSON.stringify(path.join(desktop, 'src/shared/CustomerScreenView.tsx').replace(/\\/g, '/'))};
export * as FEED from ${JSON.stringify(path.join(desktop, 'src/renderer/lib/customerDisplayFeed.ts').replace(/\\/g, '/'))};
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';`);
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(userData, 'view.cjs'), logLevel: 'silent',
  jsx: 'automatic', nodePaths: [path.join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
const sentByPos = [];
globalThis.window = { swiftpos: { customerDisplay: { update: async (s) => { sentByPos.push(s); return { ok: true }; } } } };
const UI = require(path.join(userData, 'view.cjs'));
const html = (props) => UI.renderToStaticMarkup(UI.createElement(UI.View, props));
const plain = (o = {}) => CS.gateDisplayContent({ businessName: 'Kifaru Mart', themeId: null, logo: null, primaryHex: null, secondaryHex: null,
  accentHex: null, licensed: false, slides: null, mpesa: null, ...o });

// A fake PC: screens that can be plugged in and out, windows that record what they were sent.
function fakePc(screens) {
  const pc = { screens, store: null, windows: [], numbers: [], log: [], now: 1_000_000, timers: [] };
  pc.deps = {
    screens: () => pc.screens,
    openWindow: (s) => {
      const w = { on: s, sent: [], closed: false, cbs: [], send(ch, p) { this.sent.push([ch, p]); }, moveTo(t) { this.on = t; },
        close() { this.closed = true; this.cbs.forEach((c) => c()); }, isDestroyed() { return this.closed; }, onClosed(cb) { this.cbs.push(cb); } };
      pc.windows.push(w); return w;
    },
    showNumber: (s, ms) => pc.numbers.push([s.n, s.primary, ms]),
    readChoice: () => pc.store,
    writeChoice: (c) => { pc.store = JSON.parse(JSON.stringify(c)); },
    now: () => pc.now,
    log: (l) => pc.log.push(l),
    setTimer: (fn, ms) => { pc.timers.push({ fn, ms }); return pc.timers.length; },
    clearTimer: () => {},
  };
  pc.open = () => pc.windows.filter((w) => !w.closed);
  return pc;
}
const LAPTOP = { id: 10, x: 0, y: 0, width: 1366, height: 768, primary: true };
const FACING = { id: 22, x: 1366, y: 0, width: 1024, height: 600, primary: false };
const LEFT = { id: 7, x: -1920, y: 0, width: 1920, height: 1080, primary: false };

console.log('\nA606 — the customer screen\n');
let fakeServer = null;
try {
  console.log('1. The screen: chosen, never the cashier\'s, unplugged and plugged back');
  {
    const n = CS.numberScreens([LAPTOP, FACING, LEFT]);
    ok('screens numbered as Windows lays them out (left to right): the left monitor 1, the laptop 2, the facing screen 3',
      JSON.stringify(n.map((s) => [s.id, s.n])) === JSON.stringify([[7, 1], [10, 2], [22, 3]]));
    ok('off → nowhere, no note', CS.pickScreen([LAPTOP, FACING], { enabled: false, displayId: 22 }).screen === null
      && CS.pickScreen([LAPTOP, FACING], { enabled: false, displayId: 22 }).note === null);
    ok('never the cashier\'s own (primary) screen — off with a note', CS.pickScreen([LAPTOP, FACING], { enabled: true, displayId: 10 }).screen === null
      && /cashier/.test(CS.pickScreen([LAPTOP, FACING], { enabled: true, displayId: 10 }).note ?? ''));
    ok('the chosen screen missing with one screen left → off, "only one screen is connected"',
      /only one screen/.test(CS.pickScreen([LAPTOP], { enabled: true, displayId: 22 }).note ?? ''));
    ok('a stored choice that cannot be read → off', JSON.stringify(CS.cleanDisplayChoice('junk')) === '{"enabled":false,"displayId":null}'
      && CS.cleanDisplayChoice({ enabled: true, displayId: '22' }).displayId === 22);

    const pc = fakePc([LAPTOP, FACING]);
    const d = CD.createCustomerDisplay(pc.deps);
    d.apply();
    ok('nothing chosen on this PC → no window at start', pc.open().length === 0 && d.status().note === null);
    let st = d.setChoice({ enabled: true, displayId: null });
    ok('turned on without a screen named → the first screen that is not the cashier\'s; remembered per PC',
      pc.store?.enabled === true && pc.store?.displayId === 22 && st.open && st.on === 2);
    ok('the window is on that screen and was sent the state at once', pc.open()[0]?.on.id === 22 && pc.open()[0].sent.some(([ch]) => ch === 'customerDisplay:state'));
    pc.screens = [LAPTOP];
    d.apply();
    st = d.status();
    ok('the facing screen unplugged → the window closes quietly; the Tech page\'s note says why', pc.open().length === 0 && /only one screen/.test(st.note ?? '') && !st.open);
    let threw = false; try { d.update({ stage: 'sale', lines: [{ name: 'Bread', qty: 1, unitPrice: 65, lineTotal: 65 }], total: 65 }); } catch { threw = true; }
    ok('…and a sale rung meanwhile changes nothing and throws nothing', !threw && pc.open().length === 0);
    pc.screens = [LAPTOP, FACING];
    d.apply();
    ok('plugged back → it opens again, with the sale on it', pc.open().length === 1 && pc.open()[0].sent.at(-1)?.[1]?.stage === 'sale');
    pc.screens = [LAPTOP, { ...FACING, x: 0, y: 768 }];
    d.apply();
    ok('the screen moved (Windows display settings) → the window follows; still one window', pc.open().length === 1 && pc.open()[0].on.y === 768);
    st = d.setChoice({ enabled: false, displayId: null });
    ok('turned off → closed; remembered', pc.open().length === 0 && pc.store.enabled === false && !st.open);
    const brokenPc = fakePc([LAPTOP, FACING]);
    brokenPc.deps.screens = () => { throw new Error('screen module gone'); };
    const d2 = CD.createCustomerDisplay(brokenPc.deps);
    let threw2 = false; try { d2.apply(); d2.status(); } catch { threw2 = true; }
    ok('the screens cannot be read → nothing throws (it stays off)', !threw2 && brokenPc.open().length === 0);
    // Show test screen / Identify
    st = d.test('retail', 'KES');
    const tw = pc.open()[0];
    ok('"Show test screen" with the screen off: opens on the facing screen with a sample sale', !!tw && tw.sent.at(-1)[1].stage === 'sale'
      && tw.sent.at(-1)[1].lines.length === 2 && pc.timers.at(-1).ms === CD.TEST_MS);
    pc.timers.at(-1).fn();
    ok('…and goes again after the test (the screen is off)', pc.open().length === 0);
    ok('"Identify displays": a number on every screen, the cashier\'s marked', d.identify() === 2
      && JSON.stringify(pc.numbers) === JSON.stringify([[1, true, CD.IDENTIFY_MS], [2, false, CD.IDENTIFY_MS]]));
    const one = fakePc([LAPTOP]);
    const d3 = CD.createCustomerDisplay(one.deps);
    st = d3.test('retail', 'KES');
    ok('"Show test screen" with one screen only → nothing opens, a note', one.open().length === 0 && /plug in/.test(st.note ?? ''));
  }

  console.log('\n2. The state sent: cleaned in main, only what the customer may see');
  {
    const raw = {
      stage: 'sale', mode: 'restaurant', currency: 'KES', table: '4', cashier: 'Brian', staff_id: 'u-brian', pin: '4321', manager_pin: '9999',
      customer: { name: 'Wanjiru', phone: '0712345678' }, notes: 'staff meal', cost_total: 310,
      lines: [{ name: 'Chicken burger', qty: 2, unitPrice: 450, lineTotal: 900, cost_price: 155, product: { id: 'p1', cost_price: 155, supplier: 'Kenchic' }, notes: 'no onions for the boss', detail: 'Large, extra cheese' }],
      subtotal: 900, discount: 0, total: 900, amountDue: 900, paid: 5000, change: 4100, method: 'cash',
    };
    const s = CS.sanitiseDisplayState(raw);
    const j = JSON.stringify(s);
    ok('no cost price, staff name, PIN, customer, note or product record crosses', !['cost', '155', 'Kenchic', 'Brian', 'u-brian', '4321', '9999', 'Wanjiru', '0712', 'staff meal', 'boss', '"product"'].some((x) => j.includes(x)), j);
    ok('exactly the display fields', JSON.stringify(Object.keys(s).sort()) === JSON.stringify(['amountDue', 'change', 'currency', 'discount', 'lines', 'method', 'mode', 'paid', 'since', 'stage', 'subtotal', 'table', 'total'])
      && JSON.stringify(Object.keys(s.lines[0]).sort()) === JSON.stringify(['detail', 'discount', 'lineTotal', 'name', 'qty', 'unit', 'unitPrice']));
    ok('during a sale: no payment figures (paid / change / method)', s.paid === 0 && s.change === 0 && s.method === null);
    ok('idle carries no sale at all', JSON.stringify(CS.sanitiseDisplayState({ ...raw, stage: 'idle' }).lines) === '[]' && CS.sanitiseDisplayState({ ...raw, stage: 'idle' }).total === 0
      && CS.sanitiseDisplayState({ ...raw, stage: 'idle' }).table === null);
    ok('"Thank you" carries the totals and the change, never the lines', CS.sanitiseDisplayState({ ...raw, stage: 'thanks' }).lines.length === 0
      && CS.sanitiseDisplayState({ ...raw, stage: 'thanks' }).change === 4100);
    const odd = CS.sanitiseDisplayState({ stage: 'nonsense', lines: 'x' });
    ok('an unknown stage → idle; junk numbers → 0; names trimmed to 60; at most 80 lines; a table only for food', odd.stage === 'idle'
      && CS.sanitiseDisplayState({ stage: 'sale', total: 'abc', lines: [{ name: 'x'.repeat(200), qty: -3, lineTotal: Infinity }] }).lines[0].name.length === 60
      && CS.sanitiseDisplayState({ stage: 'sale', total: 'abc', lines: [{ qty: -3 }] }).total === 0
      && CS.sanitiseDisplayState({ stage: 'sale', lines: Array.from({ length: 200 }, (_, i) => ({ name: `L${i}` })) }).lines.length === 80
      && CS.sanitiseDisplayState({ stage: 'sale', mode: 'retail', table: '4' }).table === null);
    const pc = fakePc([LAPTOP, FACING]); pc.store = { enabled: true, displayId: 22 };
    const d = CD.createCustomerDisplay(pc.deps); d.apply();
    d.update(raw);
    const sent = pc.open()[0].sent.at(-1)[1];
    ok('main cleans what the POS sends before the customer screen gets it', !JSON.stringify(sent).includes('155') && !JSON.stringify(sent).includes('Brian') && sent.lines[0].name === 'Chicken burger');
    const cartItem = { product: { id: 'p1', name: 'Chicken burger', cost_price: 155, base_price: 450, supplier: 'Kenchic', category_id: 'c1' }, quantity: 2, unitPrice: 450, lineTotal: 900,
      selectedVariants: [{ groupName: 'Size', optionName: 'Large', priceAdjustment: 0 }], selectedModifiers: [{ groupName: 'Add', optionName: 'Extra cheese', price: 0 }],
      notes: 'no onions for the boss', lineId: 'L1', kotSent: true };
    const view = (o = {}) => ({ paid: null, paying: false, cart: [cartItem], pay: null, mode: 'restaurant', currency: 'KES', table: '4', byLine: { L1: 50 }, subtotal: 900, toPay: 850, offerOff: 50, ...o });
    const fs1 = UI.FEED.displayState(view());
    ok('the POS page sends only display fields (name, options, qty, prices, the offer) — never the product record or the note',
      !/cost|Kenchic|boss|"product"|kotSent|lineId/.test(JSON.stringify(fs1)) && fs1.lines[0].detail === 'Large, Extra cheese' && fs1.lines[0].discount === 50 && fs1.total === 850, JSON.stringify(fs1));
    const feedSrc = src('renderer/lib/customerDisplayFeed.ts'), posSrc = src('renderer/pages/POSPage.tsx');
    ok('the POS page loads its feed on first use (import()), never in its main chunk', posSrc.includes("const loadDisplayFeed = () => import('../lib/customerDisplayFeed');")
      && !/^import (?!type )[^\n]*customerDisplayFeed/m.test(posSrc) && feedSrc.includes("posApi.customerDisplay?.update(s)"));
    ok('the payment screen hands over only the discount, the amount due and its legs', src('renderer/components/PaymentModal.tsx')
      .includes("useEffect(() => { onDisplay?.({ discount: discountAmount, amountDue, legs, view: legView }); }, [discountAmount, amountDue, legView, legs]);"));
    const pf = UI.FEED.payFigures({ discount: 0, amountDue: 130, legs: [{ method: 'cash', tendered: '' }], view: [{ method: 'cash', resolvedTendered: 130, change: 0 }] });
    const pf2 = UI.FEED.payFigures({ discount: 0, amountDue: 330, legs: [{ method: 'cash', tendered: '500' }, { method: 'mpesa', tendered: '' }],
      view: [{ method: 'cash', resolvedTendered: 500, change: 300 }, { method: 'mpesa', resolvedTendered: 130, change: 0 }] });
    ok('cash given only when the cashier typed it; the change; the method of the leg being paid', pf.paid === 0 && pf.method === 'cash'
      && pf2.paid === 500 && pf2.change === 300 && pf2.method === 'mpesa');
    ok('the bridge, the schemas and the handlers are there (main/preload, ipcSchemas, ipc/customerDisplay)', src('main/preload.ts').includes("ipcRenderer.invoke('customerDisplay:update', state)")
      && src('main/ipcSchemas.ts').includes("'customerDisplay:update':   { kind: 'object' }") && src('main/ipc/customerDisplay.ts').includes("customerDisplay().update(raw)"));
  }

  console.log('\n3. Premium gated: themes for the look, the online licence for the slideshow and M-Pesa');
  {
    const IMG = (n) => `https://res.cloudinary.com/zaptill/image/upload/v1/s/offer-${n}.jpg`;
    const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
    const all = { themeId: 'ocean', logo: LOGO, primaryHex: '#E11D48', secondaryHex: '#ffff00', licensed: true,
      slides: { slides: [{ url: IMG(1) }], seconds: 6 }, mpesa: { kind: 'paybill', number: '4098201', account: 'SHOP 12' } };
    const g = plain(all);
    ok('themes + licence: the logo, the colours (lower-cased), the slideshow, the M-Pesa details', g.brand?.logo === LOGO && g.brand?.primaryHex === '#e11d48'
      && g.slides.length === 1 && g.mpesa?.number === '4098201' && g.mpesa?.account === 'SHOP 12' && g.seconds === 6);
    const noThemes = plain({ ...all, themeId: null });
    ok('no themes → no brand colours and no logo (the slideshow and M-Pesa still follow the licence)', noThemes.brand === null && noThemes.slides.length === 1 && !!noThemes.mpesa);
    const noLicence = plain({ ...all, licensed: false });
    ok('no online licence → no slideshow and no M-Pesa details (the look still follows themes)', noLicence.slides.length === 0 && noLicence.mpesa === null && !!noLicence.brand);
    ok('without premium the name is plain; an SVG or a non-image "logo" is never shown', plain({}).brand === null && plain({}).businessName === 'Kifaru Mart'
      && plain({ themeId: 'ocean', logo: 'data:image/svg+xml;base64,PHN2Zz4=' }).brand.logo === null && plain({ businessName: '' }).businessName === 'Welcome');
    ok('the receipt\'s M-Pesa line → the details (Buy Goods, Paybill with its account)', JSON.stringify(CS.mpesaFromReceiptLine('Buy Goods', '123456')) === '{"kind":"buy_goods","number":"123456","account":null}'
      && JSON.stringify(CS.mpesaFromReceiptLine('Paybill', '4098201, Account 1234')) === '{"kind":"paybill","number":"4098201","account":"1234"}'
      && CS.mpesaFromReceiptLine('Paybill', 'call us') === null);

    // main's content on REAL SQLite — the gate wired to the branding row, the licence and the receipt's M-Pesa line
    const L = require(path.join(dist, 'localDb.js'));
    const db = L.getLocalDb();
    db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, currency, logged_in_at) VALUES (1, 'tok', 'r1', 'u-owner', 'biz-6', 'Kifaru Mart', 'KES', '2026-10-28T00:00:00Z')`).run();
    const DC = require(path.join(dist, 'deviceConfig.js'));
    DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://127.0.0.1:9', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'POS 1', business_type: 'retail' });
    db.prepare(`INSERT INTO branding (business_id, accent_hex, logo_png, theme_id, primary_hex, secondary_hex) VALUES ('biz-6', NULL, ?, NULL, '#e11d48', NULL)`).run(LOGO);
    require(path.join(dist, 'receiptPay.js')).setReceiptPay({ label: 'Buy Goods', number: '123456' });
    const W = require(path.join(dist, 'customerDisplayWire.js'));
    W.setCustomerScreenList({ slides: [{ url: IMG(1) }], seconds: 9 });
    DC.saveDeviceConfig({ web_pos_enabled: false });
    let c = W.customerDisplayContent();
    ok('main, themes off and no licence: the name only — no logo, no colours, no M-Pesa, no slides', c.businessName === 'Kifaru Mart' && c.brand === null && c.mpesa === null && c.slideKeys.length === 0 && c.mode === 'retail');
    db.prepare(`UPDATE branding SET theme_id = 'ocean'`).run();
    db.prepare(`UPDATE device_config SET web_pos_enabled = 1 WHERE id = 1`).run();
    c = W.customerDisplayContent();
    ok('main, themes on and the licence: the logo and colours, the M-Pesa till number, the slideshow\'s seconds', c.brand?.logo === LOGO && c.brand?.primaryHex === '#e11d48'
      && c.mpesa?.kind === 'buy_goods' && c.mpesa?.number === '123456' && c.seconds === 9);

    // the slideshow cache: once per image, by hash; nothing without the licence
    const dir = path.join(userData, 'slides-test');
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
    let store = null; const asked = []; let now = 5_000_000;
    const answers = {
      [IMG(1)]: { type: 'image/jpeg', body: JPEG }, [IMG(2)]: { type: 'image/png', body: PNG },
      [IMG(3)]: { type: 'text/html', body: Buffer.from('<html>') }, [IMG(4)]: { type: 'image/jpeg', body: Buffer.alloc(CS.MAX_SLIDE_BYTES + 1, 0xff) },
      [IMG(5)]: { type: 'image/png', body: Buffer.from('GIF89a not a png') },
    };
    const cache = SL.createSlideCache({ dir, store: { read: () => store, write: (v) => { store = v; } }, now: () => now, log: () => {},
      fetch: async (url) => { asked.push(url); const a = answers[url]; return { ok: !!a, status: a ? 200 : 404, type: a?.type ?? '', length: a ? a.body.length : null, body: async () => a.body }; } });
    cache.setList({ slides: [{ url: IMG(1) }, { url: IMG(2) }], seconds: 7 });
    let r = await cache.sync(false);
    ok('no licence → nothing fetched at all', asked.length === 0 && r.skipped);
    r = await cache.sync(true);
    ok('with the licence: each image fetched once and kept, named by its hash', asked.length === 2 && r.fetched === 2
      && fs.readdirSync(dir).sort().join(',') === [`${SL.slideKey(IMG(1))}.jpg`, `${SL.slideKey(IMG(2))}.png`].sort().join(','));
    r = await cache.sync(true); await cache.sync(true);
    ok('the next passes fetch NOTHING (cached by hash)', asked.length === 2 && r.kept === 2 && r.fetched === 0);
    cache.setList({ slides: [{ url: IMG(2) }, { url: IMG(1) }], seconds: 7 });
    await cache.sync(true);
    ok('a re-ordered list: no download, the order follows the owner', asked.length === 2
      && JSON.stringify(cache.shown().keys) === JSON.stringify([SL.slideKey(IMG(2)), SL.slideKey(IMG(1))]));
    ok('an image as the screen asks for it: a data URL from this PC; a bad key → nothing', cache.image(SL.slideKey(IMG(2))).startsWith('data:image/png;base64,')
      && cache.image('../../etc/passwd') === null);
    cache.setList({ slides: [{ url: IMG(1) }, { url: IMG(3) }, { url: IMG(4) }, { url: IMG(5) }], seconds: 7 });
    r = await cache.sync(true);
    ok('a page instead of an image, an image over 2 MB, a file that is not what it says: refused, never stored; the removed one deleted',
      r.refused === 3 && r.removed === 1 && fs.readdirSync(dir).length === 1);
    const before = asked.length;
    await cache.sync(true);
    ok('a refused image is not asked again within the hour', asked.length === before);
    now += SL.RETRY_MS;
    await cache.sync(true);
    ok('…and is asked again after it', asked.length === before + 3);
    ok('a list that is not said (an older cloud) is kept; null takes it down', cache.setList(undefined) === false && cache.list().slides.length === 4
      && cache.setList(null) === true && cache.list() === null);
    await cache.sync(true);
    ok('…and the images go with it', fs.readdirSync(dir).length === 0);
  }

  console.log('\n4. Stages: idle → sale → payment → thank you → idle');
  {
    const pc = fakePc([LAPTOP, FACING]); pc.store = { enabled: true, displayId: 22 };
    const d = CD.createCustomerDisplay(pc.deps); d.apply();
    const stages = [];
    const step = (raw, at) => { pc.now = at; const s = d.update(raw); stages.push([s.stage, s.since]); return s; };
    step({ stage: 'idle' }, 1000);
    step({ stage: 'sale', lines: [{ name: 'Bread', qty: 1, unitPrice: 65, lineTotal: 65 }], total: 65 }, 2000);
    step({ stage: 'sale', lines: [{ name: 'Bread', qty: 2, unitPrice: 65, lineTotal: 130 }], total: 130 }, 3000);
    step({ stage: 'payment', total: 130, amountDue: 130, method: 'cash', paid: 200, change: 70 }, 4000);
    const t = step({ stage: 'thanks', total: 130, amountDue: 130, change: 70 }, 5000);
    ok('each stage\'s start stamped in main (a sale that grows keeps its start)', JSON.stringify(stages.slice(1)) === JSON.stringify([['sale', 2000], ['sale', 2000], ['payment', 4000], ['thanks', 5000]]), JSON.stringify(stages));
    ok('"Thank you" stays 8 s, then the customer sees idle', CS.shownStage(t, 5000 + 7999) === 'thanks' && CS.shownStage(t, 5000 + CS.THANKS_MS) === 'idle');
    ok('every change reached the customer screen in order', JSON.stringify(pc.open()[0].sent.slice(1).map(([, s]) => s.stage)) === JSON.stringify(['idle', 'sale', 'sale', 'payment', 'thanks']));
    const base = { paid: null, paying: false, cart: [], pay: null, mode: 'retail', currency: 'KES', table: null, byLine: {}, subtotal: 0, toPay: 0, offerOff: 0 };
    const line = { product: { name: 'Bread' }, quantity: 2, unitPrice: 65, lineTotal: 130, selectedVariants: [], selectedModifiers: [] };
    const paid = { total: 130, discountAmount: 0, amountDue: 130, legs: [{ method: 'cash', amount: 130, amount_tendered: 200, change_given: 70, reference: null }] };
    const st4 = [UI.FEED.displayState(base), UI.FEED.displayState({ ...base, cart: [line], subtotal: 130, toPay: 130 }),
      UI.FEED.displayState({ ...base, cart: [line], paying: true, pay: { discount: 0, amountDue: 130, legs: [{ method: 'cash', tendered: '200' }], view: [{ method: 'cash', resolvedTendered: 200, change: 70 }] } }),
      UI.FEED.displayState({ ...base, paid, cart: [line] })];
    ok('the POS page: empty → idle; items → sale; the payment screen → payment (cash given, change); a paid sale → thank you',
      JSON.stringify(st4.map((x) => x.stage)) === JSON.stringify(['idle', 'sale', 'payment', 'thanks']) && st4[2].paid === 200 && st4[2].change === 70
      && st4[3].change === 70 && st4[3].lines.length === 0);
    UI.FEED.feedCustomerDisplay(null); await new Promise((r) => setTimeout(r, 80));
    ok('…signing out of the POS sends idle', sentByPos.at(-1)?.stage === 'idle');
    const content = plain({});
    let out = html({ state: CS.idleState('retail'), content, slides: [] });
    ok('the view, idle: the business name plainly', out.includes('data-testid="cs-idle"') && out.includes('Kifaru Mart'));
    out = html({ state: CS.sanitiseDisplayState({ stage: 'payment', mode: 'retail', currency: 'KES', total: 130, amountDue: 130, method: 'cash', paid: 200, change: 70, lines: [{ name: 'Bread', qty: 2, unitPrice: 65, lineTotal: 130 }] }), content, slides: [] });
    ok('the view, payment by cash: to pay, given and the change', out.includes('To pay') && out.includes('200.00') && out.includes('70.00'));
    out = html({ state: t, content, slides: [], now: 5100 });
    ok('the view, thank you: the change; then idle', out.includes('Your change') && html({ state: t, content, slides: [], now: 5000 + CS.THANKS_MS }).includes('cs-idle'));
    const mp = plain({ licensed: true, mpesa: { kind: 'buy_goods', number: '123456', account: null } });
    out = html({ state: CS.sanitiseDisplayState({ stage: 'payment', mode: 'retail', currency: 'KES', total: 130, amountDue: 130, method: 'mpesa' }), content: mp, slides: [] });
    ok('the view, payment by M-Pesa (licence): "Buy Goods till number" 123 456 large — no QR code made up', out.includes('Buy Goods till number') && out.includes('123 456') && !/qr/i.test(out));
  }

  console.log('\n5. The words by business type');
  {
    const line = (o) => CS.sanitiseDisplayState({ stage: 'sale', lines: [o] }).lines[0];
    ok('shop: "Your items", "2 × 150.00"', CS.displayWords('retail').heading === 'Your items' && CS.lineQuantityText(line({ qty: 2, unitPrice: 150 })) === '2 × 150.00');
    ok('restaurant / café: "Your order", the table on the bill', CS.displayWords('restaurant').heading === 'Your order' && CS.displayWords('cafe').heading === 'Your order'
      && html({ state: CS.sanitiseDisplayState({ stage: 'sale', mode: 'restaurant', table: '4', lines: [{ name: 'Pilau', qty: 1, unitPrice: 350, lineTotal: 350 }], total: 350 }), content: plain({}), slides: [] }).includes('Table 4'));
    ok('petrol: litres and the price per litre', CS.displayWords('petrol_station').heading === 'Your purchase'
      && CS.lineQuantityText(line({ qty: 10.8401, unit: 'L', unitPrice: 184.5 })) === '10.840 L × 184.50 per litre');
    ok('weighed: kg and the price per kg (grams shown in grams)', CS.lineQuantityText(line({ qty: 0.452, unit: 'kg', unitPrice: 650 })) === '0.452 kg × 650.00 per kg'
      && CS.lineQuantityText(line({ qty: 0.25, unit: 'g', unitPrice: 1200 })) === '250 g × 1,200.00 per kg');
    ok('parking and every other type have their own words; "POS", never "till"', CS.displayWords('parking').heading === 'Your parking' && CS.displayWords('other').heading === 'Your items'
      && ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'].every((m) => !/\btill\b/i.test(JSON.stringify(CS.displayWords(m)))));
    const out = html({ state: CS.sanitiseDisplayState({ stage: 'sale', mode: 'petrol_station', lines: [{ name: 'Super Petrol', qty: 10.84, unit: 'L', unitPrice: 184.5, lineTotal: 2000 }], total: 2000 }), content: plain({}), slides: [] });
    ok('the view, petrol: the grade, its litres and the amount', out.includes('Super Petrol') && out.includes('10.840 L × 184.50 per litre') && out.includes('2,000.00'));
    const fuelLines = UI.FEED.displayLines([{ product: { name: 'Super Petrol' }, quantity: 10.84, unitPrice: 184.5, lineTotal: 2000, isFuel: true, selectedVariants: [], selectedModifiers: [] },
      { product: { name: 'Goat meat' }, quantity: 0.75, unitPrice: 900, lineTotal: 675, measureUnit: 'kg', selectedVariants: [], selectedModifiers: [] }], {});
    ok('the POS page: a fuel line in litres, a weighed line in kg', fuelLines[0].unit === 'L' && fuelLines[1].unit === 'kg');
  }

  console.log('\n6. The bundle: the customer screen loads only in its own window');
  {
    const entryTsx = src('renderer/main.tsx');
    ok('main.tsx loads the page with import() (never statically), only for #/customer-display',
      entryTsx.includes("const CustomerDisplayPage = lazy(() => import('./pages/CustomerDisplayPage'));") && !/^import[^\n]*CustomerDisplayPage/m.test(entryTsx)
      && entryTsx.includes("window.location.hash.startsWith('#/customer-display')"));
    let vite = null;
    try { vite = await import(pathToFileURL(require.resolve('vite', { paths: [desktop] })).href); } catch { /* not installed */ }
    if (!vite) console.log('  SKIPPED the build check — vite is not installed here (npm ci in apps/desktop)');
    else {
      const out = await vite.build({ root: desktop, configFile: path.join(desktop, 'vite.config.ts'), logLevel: 'silent', build: { write: false, emptyOutDir: false } });
      const chunks = (Array.isArray(out) ? out[0] : out).output.filter((o) => o.type === 'chunk');
      const main = chunks.find((c) => c.isEntry);
      const mods = (c) => Object.keys(c.modules).map((m) => m.replace(/\\/g, '/'));
      const inMain = (rel) => mods(main).some((m) => m.endsWith(`/src/${rel}`));
      const kb = (main.code.length / 1024).toFixed(1);
      console.log(`  (built: main chunk ${kb} kB; the customer screen ${((chunks.find((c) => mods(c).some((m) => m.endsWith('/pages/CustomerDisplayPage.tsx')))?.code.length ?? 0) / 1024).toFixed(1)} kB)`);
      ok('the customer screen page, its view and its rules are their own chunk — not in the POS\'s', !inMain('renderer/pages/CustomerDisplayPage.tsx')
        && !inMain('shared/CustomerScreenView.tsx') && !inMain('shared/customerScreen.ts') && !inMain('renderer/lib/customerDisplayFeed.ts')
        && chunks.some((c) => c.isDynamicEntry && mods(c).some((m) => m.endsWith('/src/renderer/pages/CustomerDisplayPage.tsx'))));
      // Both budgets: petrol-pos-a588 (≤ 452 kB) and lazy-load-a517 (< 450 kB). 448.9 kB before A606.
      ok('the POS\'s main chunk < 450 kB still (lazy-load-a517) and ≤ 452 kB (petrol-pos-a588)', main.code.length < 450 * 1024, `${kb} kB`);
    }
  }
} finally {
  if (fakeServer) fakeServer.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
