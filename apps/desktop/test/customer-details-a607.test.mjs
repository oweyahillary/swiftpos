// A607 — customer details at the counter, on BOTH screens: the cashier's (main) screen and the customer screen (A606's
// second screen); the M-Pesa prompt from the desktop POS; the buyer's KRA PIN on the sale, the receipt and to KRA.
//
// Owner, 2026-10-28: "a feature where clients details can be captured by the cashier both on the main screen and the second
// screen also, and if mpesa integration is available the client can key in their mpesa, if KRA is integrated they can key
// in KRA pin etc" — "should work for both main and second screen".
//
// Drives the REAL compiled dist/main (customerDetails, customerDisplay — the controller with a fake PC —, mpesaStk with a
// fake cloud, localDb on a REAL SQLite file, deviceConfig, syncEngine's pull from a stand-in cloud and createLocalOrder,
// referenceBundle), the REAL shared views (CustomerAskForm, CustomerTypesIt) bundled with esbuild and rendered to HTML, and
// @swiftpos/printing for the paper.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/customer-details-a607.test.mjs
//
//   1  the rules: Kenyan phones → 2547/2541XXXXXXXX; the KRA PIN (A/P, 9 digits, a letter; upper-cased); the request to the
//      customer screen a whitelist; the answer only the typed fields; consent (no customer record without "save").
//   2  the customer screen's form round trip THROUGH MAIN: asked only when allowed; the request cleaned; an answer only from
//      the customer screen's own page, only to the open request, checked (a bad PIN back to the customer), only the typed
//      fields reaching the cashier; skip / a screen that closed told to the cashier; nothing attached to the sale in main.
//   3  the cashier accepts before it attaches (the POS page's wiring); "Customer types it" covers everything and shows only
//      the form, the total and the consent line.
//   4  the M-Pesa prompt with a fake cloud: offered only when set up and online; the number normalised, the amount whole
//      shillings; waiting → paid (the M-Pesa receipt) / not completed / declined / no connection / timed out; both screens
//      shown (the customer's without the phone or the receipt); a late answer after reset ignored.
//   5  premium: the second-screen form needs the online licence and the PC's touch-screen setting.
//   6  the local schema 78 (orders.buyer_kra_pin), REQUIRED with it; a sale saves the PIN (normalised; a bad one dropped) and
//      sends it to the cloud; the receipt prints "Buyer PIN: …"; the eTIMS flag pulled (older cloud → kept) and relayed.
//   7  the bundle: every new panel lazy — the POS's main chunk < 450 kB (lazy-load-a517) and ≤ 452 kB (petrol-pos-a588).
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted and checked byte for byte — listed in the A607 entry).
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
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a607-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.22', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }), on() {} }, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }, net: { isOnline: () => true }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const CDT = require(path.join(dist, 'customerDetails.js'));
const CD = require(path.join(dist, 'customerDisplay.js'));
const STK = require(path.join(dist, 'mpesaStk.js'));

// The REAL views, bundled for Node and rendered to HTML (no browser).
const entry = path.join(userData, 'entry.tsx');
const fwd = (p) => JSON.stringify(path.join(desktop, p).split(path.sep).join('/'));
fs.writeFileSync(entry, `export { default as Form, StkBanner } from ${fwd('src/shared/CustomerAskForm.tsx')};
export { default as TypesIt } from ${fwd('src/renderer/components/CustomerTypesIt.tsx')};
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';`);
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(userData, 'view.cjs'), logLevel: 'silent',
  jsx: 'automatic', nodePaths: [path.join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
const UI = require(path.join(userData, 'view.cjs'));
const html = (C, props) => UI.renderToStaticMarkup(UI.createElement(C, props));

// A fake PC (as A606's): windows that record what they were sent; the cashier's window records what main told it.
function fakePc() {
  const pc = { screens: [{ id: 10, x: 0, y: 0, width: 1366, height: 768, primary: true }, { id: 22, x: 1366, y: 0, width: 1024, height: 600, primary: false }],
    store: { enabled: true, displayId: 22 }, windows: [], cashier: [], now: 1_000_000, log: [] };
  pc.deps = {
    screens: () => pc.screens,
    openWindow: (s) => {
      const w = { on: s, sent: [], closed: false, cbs: [], page: { id: 'customer-page' }, send(ch, p) { this.sent.push([ch, p]); }, moveTo(t) { this.on = t; },
        close() { this.closed = true; this.cbs.forEach((c) => c()); }, isDestroyed() { return this.closed; }, onClosed(cb) { this.cbs.push(cb); },
        isSender(x) { return x === this.page; } };
      pc.windows.push(w); return w;
    },
    showNumber: () => {}, readChoice: () => pc.store, writeChoice: (c) => { pc.store = c; }, now: () => pc.now, log: (l) => pc.log.push(l),
    setTimer: () => 0, clearTimer: () => {}, toCashier: (ch, p) => pc.cashier.push([ch, p]),
  };
  pc.win = () => pc.windows.filter((w) => !w.closed)[0];
  return pc;
}
const ALLOWED = { touch: true, licensed: true };

let srv = null;
console.log('\nA607 — customer details at the counter, on both screens\n');
try {
  console.log('1. The rules');
  {
    const n = CDT.normaliseKenyanPhone;
    ok('Kenyan numbers → 2547XXXXXXXX / 2541XXXXXXXX: 07XX, 01XX, 7XX, 2547XX, +254 7XX, with spaces or dashes',
      n('0712345678') === '254712345678' && n('0112 345 678') === '254112345678' && n('712345678') === '254712345678'
      && n('254712345678') === '254712345678' && n('+254 712-345-678') === '254712345678' && n(' 0722 000 111 ') === '254722000111');
    ok('not a Kenyan mobile → null: 08XX, too short / long, letters, +0712, 2548XX, empty',
      [null, '', '0812345678', '071234567', '07123456789', '07123x5678', '+0712345678', '254812345678', '+712345678', '2540712345678'].every((v) => n(v) === null));
    ok('the PIN: A or P, 9 digits, a letter — typed in lower case or with spaces it is upper-cased',
      CDT.kraPinOk('A123456789Z') && CDT.kraPinOk('p051234567x') && CDT.normaliseKraPin('a123 456 789-z') === 'A123456789Z' && CDT.kraPinError('') === null);
    ok('…anything else refused: another first letter, 8 or 10 digits, no last letter',
      ['B123456789Z', 'A12345678Z', 'A1234567890Z', 'A123456789', '1234567890A'].every((p) => !CDT.kraPinOk(p) && CDT.kraPinError(p)));
    ok('the sale\'s PIN as an order carries it: valid → upper case, blank → null, junk → "bad"',
      CDT.saleBuyerPin('a123456789z') === 'A123456789Z' && CDT.saleBuyerPin(undefined) === null && CDT.saleBuyerPin('') === null && CDT.saleBuyerPin('X1') === 'bad');
    const a = CDT.sanitiseAsk({ id: 'ask-abcdef', purpose: 'details', needPin: true, amount: 1234.567, currency: 'KES',
      customerName: 'Mary Wanjiku', cashier: 'Cate', costPrice: 50, phone: '0712345678', customers: [{ name: 'John' }] });
    ok('the request TO the customer screen is a whitelist — no customer, cashier, cost price or other customers cross',
      JSON.stringify(a) === JSON.stringify({ id: 'ask-abcdef', purpose: 'details', needPin: true, amount: 1234.57, currency: 'KES' }), JSON.stringify(a));
    ok('…an unreadable request is none; the PIN is asked only with the details', CDT.sanitiseAsk({ id: 'x', purpose: 'details' }) === null
      && CDT.sanitiseAsk({ id: 'ask-abcdef', purpose: 'rename' }) === null && CDT.sanitiseAsk({ id: 'ask-abcdef', purpose: 'mpesa', needPin: true }).needPin === false);
    const ans = CDT.cleanAnswer({ id: 'ask-abcdef', name: '  Mary   Wanjiku ', phone: '0712 345 678', kraPin: 'a123456789z', save: true,
      customer_id: 'c-evil', discount: 100, role: 'owner' }, a);
    ok('the answer FROM it: only id, name, phone, kraPin, save — cleaned (name spaces, phone 254…, PIN upper case)',
      ans.ok && JSON.stringify(ans.value) === JSON.stringify({ id: 'ask-abcdef', name: 'Mary Wanjiku', phone: '254712345678', kraPin: 'A123456789Z', save: true }), JSON.stringify(ans));
    ok('…only to the request that is open (another id refused)', !CDT.cleanAnswer({ id: 'ask-other0', phone: '0712345678' }, a).ok && !CDT.cleanAnswer({ id: 'ask-abcdef' }, null).ok);
    const bad = CDT.cleanAnswer({ id: 'ask-abcdef', phone: '0812', kraPin: 'B1' }, a);
    ok('…a bad phone or PIN comes back to the customer by field', !bad.ok && /Kenyan/.test(bad.errors.phone) && /KRA PIN/.test(bad.errors.kraPin));
    ok('…"save" needs a name and a phone; nothing typed asks to type or skip', /name and phone/.test(CDT.cleanAnswer({ id: 'ask-abcdef', name: 'Mary', save: true }, a).errors?.save ?? '')
      && /Skip/.test(CDT.cleanAnswer({ id: 'ask-abcdef' }, a).errors?.form ?? ''));
    const noPin = CDT.sanitiseAsk({ id: 'ask-abcdef', purpose: 'details', needPin: false });
    ok('…a PIN the request did not ask for (eTIMS off) is dropped', CDT.cleanAnswer({ id: 'ask-abcdef', name: 'Mary', kraPin: 'A123456789Z' }, noPin).value?.kraPin === null);
    const mp = CDT.sanitiseAsk({ id: 'ask-mpesa1', purpose: 'mpesa', amount: 500 });
    ok('the M-Pesa request: the phone is needed, and only the phone comes back',
      !CDT.cleanAnswer({ id: 'ask-mpesa1' }, mp).ok && JSON.stringify(CDT.cleanAnswer({ id: 'ask-mpesa1', phone: '0712345678', name: 'X', kraPin: 'A123456789Z', save: true }, mp).value)
        === JSON.stringify({ id: 'ask-mpesa1', name: null, phone: '254712345678', kraPin: null, save: false }));
    const only = CDT.consentPlan({ name: 'Mary', phone: '254712345678', kraPin: 'A123456789Z', save: false }, true);
    ok('consent — no "save": NO customer record; the PIN on the invoice, the name on the receipt, the phone for the prompt only (not on the sale)',
      only.saveCustomer === null && JSON.stringify(only.sale) === JSON.stringify({ customer_name: 'Mary', buyer_kra_pin: 'A123456789Z' }) && only.stkPhone === '254712345678');
    const saved = CDT.consentPlan({ name: 'Mary', phone: '254712345678', kraPin: 'A123456789Z', save: true }, true);
    ok('consent — "Save my details for next time": the record (name, phone, PIN), and the phone on the sale',
      JSON.stringify(saved.saveCustomer) === JSON.stringify({ name: 'Mary', phone: '254712345678', kra_pin: 'A123456789Z' })
        && saved.sale.customer_phone === '254712345678', JSON.stringify(saved));
    ok('…eTIMS off: no PIN goes anywhere', CDT.consentPlan({ name: 'Mary', phone: null, kraPin: 'A123456789Z', save: false }, false).sale.buyer_kra_pin === undefined);
    ok('the prompt as the customer sees it: never a phone number, nothing when idle',
      !/0712|254712/.test(JSON.stringify(CDT.sanitiseStk({ stage: 'failed', amount: 500, reason: 'Request to 254712345678 cancelled', phone: '0712345678', mpesaRef: 'QJK7XT3L5P' })))
      && JSON.stringify(CDT.sanitiseStk({ stage: 'idle', amount: 9 })) === JSON.stringify({ stage: 'idle', amount: 0, currency: 'KES', reason: null }));
    ok('the words: "Waiting for M-Pesa… (check your phone)", "Paid ✓", "Not completed — try again / pay by M-Pesa Till number"',
      CDT.stkWords('waiting').title === 'Waiting for M-Pesa… (check your phone)' && CDT.stkWords('paid').title === 'Paid ✓'
      && CDT.stkWords('failed').title === 'Not completed — try again / pay by M-Pesa Till number');
    ok('amounts: whole shillings rounded up, 1 to 250,000', CDT.stkAmount(99.2) === 100 && CDT.stkAmount(100) === 100 && CDT.stkAmount(0.4) === 1
      && CDT.stkAmount(0) === null && CDT.stkAmount(250_001) === null);
  }

  console.log('\n2. The customer screen\'s form, through main');
  {
    const pc = fakePc();
    const d = CD.createCustomerDisplay(pc.deps);
    d.apply();
    const w = pc.win();
    const sentAsk = () => w.sent.filter(([ch]) => ch === 'customerDisplay:ask').map(([, p]) => p);
    const raw = { id: 'ask-round1', purpose: 'details', needPin: true, amount: 450, currency: 'KES', customerName: 'Previous customer', staff: 'Cate' };
    let r = d.askCustomer(raw, { touch: true, licensed: false });
    ok('without the online licence: refused, nothing reaches the customer screen', !r.ok && /online licence/.test(r.why) && sentAsk().length === 0);
    r = d.askCustomer(raw, { touch: false, licensed: true });
    ok('without "The customer screen is a touch screen": refused', !r.ok && /touch screen/.test(r.why) && sentAsk().length === 0);
    r = d.askCustomer(raw, ALLOWED);
    ok('allowed: the customer screen gets the CLEANED request (no previous customer, no staff)', r.ok
      && JSON.stringify(sentAsk().at(-1)) === JSON.stringify({ id: 'ask-round1', purpose: 'details', needPin: true, amount: 450, currency: 'KES' }), JSON.stringify(sentAsk()));
    const before = JSON.stringify(d.current());
    let a = d.answer({ id: 'ask-round1', name: 'Mary', phone: '0712345678' }, { id: 'the-cashier-window' });
    ok('an answer from any page but the customer screen\'s own is refused', !a.ok && pc.cashier.length === 0);
    a = d.answer({ id: 'ask-wrong01', name: 'Mary', phone: '0712345678' }, w.page);
    ok('an answer to another request is refused', !a.ok && pc.cashier.length === 0);
    a = d.answer({ id: 'ask-round1', name: 'Mary', phone: '0712345678', kraPin: 'B999' }, w.page);
    ok('a bad PIN goes back to the customer (the form stays); the cashier is told nothing yet', !a.ok && /KRA PIN/.test(a.errors.kraPin) && pc.cashier.length === 0 && d.currentAsk()?.id === 'ask-round1');
    a = d.answer({ id: 'ask-round1', name: 'Mary Wanjiku', phone: '0712 345 678', kraPin: 'a123456789z', save: true, customer_id: 'c-x', total: 1, permissions: ['*'] }, w.page);
    const told = pc.cashier.at(-1);
    ok('a good answer: checked in main, ONLY the typed fields reach the cashier\'s window',
      a.ok && told?.[0] === 'customerDisplay:answered'
      && JSON.stringify(told[1]) === JSON.stringify({ id: 'ask-round1', answer: { id: 'ask-round1', name: 'Mary Wanjiku', phone: '254712345678', kraPin: 'A123456789Z', save: true } }), JSON.stringify(told));
    ok('…the form leaves the customer screen', sentAsk().at(-1) === null && d.currentAsk() === null);
    ok('…and NOTHING is attached to the sale in main (the sale shown is unchanged — the cashier accepts first)', JSON.stringify(d.current()) === before);
    ok('…a second answer to the closed request is refused', !d.answer({ id: 'ask-round1', name: 'Again' }, w.page).ok && pc.cashier.length === 1);
    d.askCustomer({ id: 'ask-skip01', purpose: 'details' }, ALLOWED);
    d.answer({ id: 'ask-skip01', skip: true }, w.page);
    ok('Skip → the cashier is told it was skipped; the form leaves', JSON.stringify(pc.cashier.at(-1)) === JSON.stringify(['customerDisplay:answered', { id: 'ask-skip01', skipped: true }]) && d.currentAsk() === null);
    d.askCustomer({ id: 'ask-close1', purpose: 'mpesa', amount: 300 }, ALLOWED);
    d.cancelAsk('ask-other');
    ok('the cashier cancelling another request changes nothing', d.currentAsk()?.id === 'ask-close1');
    pc.screens = [pc.screens[0]];
    d.apply();
    ok('the customer screen unplugged mid-form → the cashier is told (types it instead)',
      JSON.stringify(pc.cashier.at(-1)) === JSON.stringify(['customerDisplay:answered', { id: 'ask-close1', cancelled: true }]) && d.currentAsk() === null);
    r = d.askCustomer({ id: 'ask-noscr1', purpose: 'details' }, ALLOWED);
    ok('…and with no customer screen showing, it cannot ask', !r.ok && /not showing/.test(r.why));
    pc.screens = [pc.screens[0], { id: 22, x: 1366, y: 0, width: 1024, height: 600, primary: false }];
    d.apply();
    d.askCustomer({ id: 'ask-again1', purpose: 'details' }, ALLOWED);
    pc.win().close();
    ok('the window of the customer screen closed mid-form → the cashier is told, the form is gone',
      JSON.stringify(pc.cashier.at(-1)) === JSON.stringify(['customerDisplay:answered', { id: 'ask-again1', cancelled: true }]) && d.currentAsk() === null);
    d.apply();
    d.setStk({ stage: 'waiting', amount: 200 });
    pc.win().close();
    d.apply();
    ok('a prompt under way reaches a customer screen that opened again (before the sale)',
      JSON.stringify(pc.win().sent.map(([c]) => c)) === JSON.stringify(['customerDisplay:stk', 'customerDisplay:state']), JSON.stringify(pc.win().sent.map(([c]) => c)));
    d.setStk(null);
    ok('the IPC answer is taken with its sender (main checks it is the customer screen\'s page)',
      /customerDisplay:answer', async \(e, raw\) => customerDisplay\(\)\.answer\(raw, \(e as \{ sender\?: unknown \} \| null\)\?\.sender\)/.test(src('main/ipc/customerDetails.ts'))
      && /isSender: \(sender\) => !win\.isDestroyed\(\) && sender === win\.webContents/.test(src('main/customerDisplayWire.ts')));
  }

  console.log('\n3. The cashier accepts before it attaches; "Customer types it"');
  {
    const sc = src('renderer/components/SaleCustomer.tsx');
    const pos = src('renderer/pages/POSPage.tsx');
    ok('an answer from the customer screen fills the cashier\'s form (fill) — it is not used for the sale',
      /onAnswered\(\(a\) => \{[\s\S]*?if \(a\.answer\) fill\(a\.answer/.test(sc) && !/onAnswered\([\s\S]{0,300}onDone\(/.test(sc));
    ok('…the sale carries the details only after "Use for this sale" (onDone → the POS\'s buyer → the order)',
      /onClick=\{use\}/.test(sc) && /onDone=\{\(b\) => \{ setBuyer\(b\);/.test(pos) && /\.\.\.buyer\?\.sale,/.test(pos));
    ok('…and a new sale starts with none (resetOrder)', /setOrderNote\(''\); setBuyer\(null\); \};/.test(pos));
    ok('saving a customer is the consent plan\'s (only with "save"), with the person\'s own sign-in (customer:create)',
      /if \(plan\.saveCustomer\) \{[\s\S]*?posApi\.order\.createCustomer\(plan\.saveCustomer\)/.test(sc));
    ok('a number the customer typed is masked for someone without customers.contacts', /setMasked\(!!a\.phone && !seesRef\.current\)/.test(sc)
      && /maskTypedPhone\(phone\)/.test(sc) && /seesContacts: signedInCan\('customers\.contacts'\)/.test(src('main/ipc/customerDetails.ts')));
    const page = html(UI.TypesIt, { purpose: 'details', needPin: true, amount: 1250, currency: 'KES', onDone() {}, onBack() {} });
    ok('"Customer types it": the whole window (fixed, every edge, opaque, above every layer)',
      /class="ca" data-testid="customer-ask" style="z-index:9999"/.test(page) && /\.ca\{position:fixed;inset:0;z-index:60;[^}]*background:#f6f7f9/.test(page));
    ok('…only the form: phone, name, KRA PIN (eTIMS on), "Save my details for next time", the consent line and the bill total',
      /data-testid="ca-phone"/.test(page) && /data-testid="ca-name"/.test(page) && /data-testid="ca-kraPin"/.test(page) && page.includes('Save my details for next time')
      && page.includes(CDT.CONSENT_LINE) && /Total <b>KES 1,250\.00<\/b>/.test(page));
    ok('…nothing private: it is given no customer, staff or cart — no cashier, no other customer, no menu, no line',
      !/Cashier|Cate|Manager|Mary|History|Void|Bread/.test(page) && /Back to the cashier/.test(page));
    const noPin = html(UI.TypesIt, { purpose: 'details', needPin: false, amount: 0, currency: 'KES', onDone() {}, onBack() {} });
    ok('…eTIMS off: no KRA PIN field; no total when there is none', !/data-testid="ca-kraPin"/.test(noPin) && !/data-testid="ca-total"/.test(noPin));
    const mp = html(UI.Form, { ask: { id: 'ask-m', purpose: 'mpesa', needPin: true, amount: 300, currency: 'KES' }, onSubmit: () => null, onSkip() {} });
    ok('the M-Pesa form: the number only (no name, no PIN, no save)', /data-testid="ca-phone"/.test(mp) && !/data-testid="ca-(name|kraPin|save)"/.test(mp) && /Your M-Pesa number/.test(mp));
    const keys = html(UI.Form, { ask: { id: 'ask-k', purpose: 'details', needPin: false, amount: 0, currency: 'KES' }, onSubmit: () => null, onSkip() {}, keysOnly: true });
    ok('on the customer screen the fields take the on-screen keys only (no keyboard reaches that window)', /readonly=""/i.test(keys) && /inputmode="none"/i.test(keys) && /aria-label="Keyboard"/.test(keys));
    ok('the customer screen page shows the form when asked and the prompt banner', /<CustomerAskForm key=\{ask\.id\} ask=\{ask\} keysOnly/.test(src('renderer/pages/CustomerDisplayPage.tsx'))
      && /<StkBanner stk=\{stk\} \/>/.test(src('renderer/pages/CustomerDisplayPage.tsx')));
  }

  console.log('\n4. The M-Pesa prompt from this POS (a fake cloud)');
  {
    const cloud = { calls: [], config: { configured: true }, push: { status: 200, body: { checkoutRequestId: 'ws_CO_1' } }, status: [] , online: true, throwPost: false };
    const timers = [];
    let now = 5_000_000;
    const states = [];
    const prompt = STK.createStkPrompt({
      online: () => cloud.online,
      get: async (p) => { cloud.calls.push(['GET', p]); if (p === '/api/mpesa/config') return { status: 200, json: async () => cloud.config };
        const s = cloud.status.shift() ?? { status: 'pending' }; return { status: s.http ?? 200, json: async () => s }; },
      post: async (p, b) => { cloud.calls.push(['POST', p, b]); if (cloud.throwPost) throw new Error('fetch failed'); return { status: cloud.push.status, json: async () => cloud.push.body }; },
      now: () => now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
      onState: (s) => states.push(s), log: () => {},
    });
    const tick = async () => { const t = timers.shift(); if (t) { now += t.ms; await t.fn(); } };
    cloud.online = false;
    ok('offline: not offered (and the cloud is not asked)', (await prompt.offered()) === false && cloud.calls.length === 0);
    cloud.online = true; cloud.config = { configured: false };
    ok('the business has no M-Pesa integration: not offered', (await prompt.offered()) === false);
    now += STK.CONFIG_MS + 1; cloud.config = { configured: true };
    ok('set up and online: offered — the cloud asked once per 5 minutes', (await prompt.offered()) === true && (await prompt.offered()) === true
      && cloud.calls.filter(([, p]) => p === '/api/mpesa/config').length === 2);
    let s = await prompt.start({ phone: '0812', amount: 100, ref: 'POS-1' });
    ok('a number that is not a Kenyan mobile: not sent', s.stage === 'failed' && /Kenyan/.test(s.reason) && !cloud.calls.some(([m]) => m === 'POST'));
    s = await prompt.start({ phone: '0712 345 678', amount: 449.3, ref: 'POS-ABC', currency: 'KES' });
    const post = cloud.calls.find(([m]) => m === 'POST');
    ok('sent to the cloud\'s POS route with the number normalised and whole shillings (rounded up)',
      post?.[1] === '/api/mpesa/stk-push-pos' && JSON.stringify(post[2]) === JSON.stringify({ phone: '254712345678', amount: 450, client_ref: 'POS-ABC' }), JSON.stringify(post));
    ok('…both screens: sending, then "Waiting for M-Pesa…"', states.map((x) => x.stage).join(',') === 'failed,sending,waiting' && s.stage === 'waiting');
    cloud.status.push({ status: 'pending' }, { status: 'completed', mpesaRef: 'QJK7XT3L5P' });
    await tick();
    ok('still pending → still waiting, asked again in 3 s', prompt.current().stage === 'waiting' && timers[0]?.ms === STK.POLL_MS);
    await tick();
    ok('paid → "Paid ✓" with the M-Pesa receipt (the leg\'s reference)', prompt.current().stage === 'paid' && prompt.current().mpesaRef === 'QJK7XT3L5P'
      && cloud.calls.some(([, p]) => p === '/api/mpesa/status/ws_CO_1'));
    // The customer screen's copy, through the controller (as ipc/customerDetails.ts onState does).
    const pc = fakePc(); const d = CD.createCustomerDisplay(pc.deps); d.apply();
    for (const st of states) d.setStk(st);
    const shown = pc.win().sent.filter(([ch]) => ch === 'customerDisplay:stk').map(([, p]) => p);
    ok('the customer screen shows the same progress — the stage and the amount, never the phone or the receipt',
      shown.map((x) => x.stage).join(',') === 'failed,sending,waiting,paid' && !/254712|0712|QJK7/.test(JSON.stringify(shown)) && shown.at(-1).amount === 450);
    await prompt.start({ phone: '0712345678', amount: 100, ref: 'POS-2' });
    cloud.status.push({ status: 'failed', error: 'Customer cancelled the payment request' });
    await tick();
    ok('declined → "Not completed" with the reason', prompt.current().stage === 'failed' && /cancelled/.test(prompt.current().reason));
    await prompt.start({ phone: '0712345678', amount: 100, ref: 'POS-3' });
    await prompt.reset();
    cloud.status.push({ status: 'completed', mpesaRef: 'LATE123456' });
    await tick();
    ok('reset (the cashier closed it): both screens idle; a late answer is ignored', prompt.current().stage === 'idle' && prompt.current().mpesaRef === null);
    cloud.status.length = 0;
    await prompt.start({ phone: '0712345678', amount: 100, ref: 'POS-4' });
    for (let i = 0; i < 40 && prompt.current().stage === 'waiting'; i++) await tick();
    ok('no answer in 90 s → not completed (timed out)', prompt.current().stage === 'failed' && /in time/.test(prompt.current().reason));
    cloud.push = { status: 422, body: { error: 'M-Pesa not configured' } };
    s = await prompt.start({ phone: '0712345678', amount: 100, ref: 'POS-5' });
    ok('the cloud says not set up (422) → not completed, said plainly', s.stage === 'failed' && /not set up/.test(s.reason));
    cloud.throwPost = true;
    s = await prompt.start({ phone: '0712345678', amount: 100, ref: 'POS-6' });
    ok('no connection → not completed: pay to the M-Pesa Till number', s.stage === 'failed' && /M-Pesa Till number/.test(s.reason));
    cloud.throwPost = false; cloud.online = false;
    s = await prompt.start({ phone: '0712345678', amount: 100, ref: 'POS-7' });
    ok('offline → not sent at all', s.stage === 'failed' && /offline/.test(s.reason));
    ok('the desktop calls the cloud with ITS OWN session, through the branch server where it has one (liveCloudGet / liveCloudPost)',
      /get: async \(p\) => asAnswer\(await liveCloudGet\(p\)\)/.test(src('main/ipc/customerDetails.ts')) && /post: async \(p, b\) => asAnswer\(await liveCloudPost\(p, b\)\)/.test(src('main/ipc/customerDetails.ts')));
    ok('the payment screen offers it under an M-Pesa leg, loaded on demand; the receipt fills the leg\'s reference',
      /const MpesaStk = lazy\(\(\) => import\('\.\/MpesaStkPanel'\)\)/.test(src('renderer/components/PaymentModal.tsx'))
      && /leg\.method === 'mpesa' && <Suspense fallback=\{null\}><MpesaStk [^\n]*onPaid=\{\(r\) => setLeg\(i, \{ reference: r \}\)\}/.test(src('renderer/components/PaymentModal.tsx'))
      && /if \(!offered\) return null;/.test(src('renderer/components/MpesaStkPanel.tsx')));
  }

  console.log('\n5. Premium: the customer typing on the customer screen');
  {
    ok('the gate: the online licence, then the touch screen, then the screen showing',
      !CDT.secondScreenAsk({ touch: true, licensed: false, open: true }).allowed && !CDT.secondScreenAsk({ touch: false, licensed: true, open: true }).allowed
      && !CDT.secondScreenAsk({ touch: true, licensed: true, open: false }).allowed && CDT.secondScreenAsk({ touch: true, licensed: true, open: true }).allowed);
    const ipc = src('main/ipc/customerDetails.ts');
    ok('main asks with the licence (web_pos_enabled) and this PC\'s touch-screen setting', /const gate = \(\) => \(\{ touch: customerScreenTouch\(\), licensed: licensed\(\) \}\);/.test(ipc)
      && /customerDisplay\(\)\.askCustomer\(raw, gate\(\)\)/.test(ipc) && /export const licensed = \(\): boolean => \{ try \{ return getDeviceConfig\(\)\?\.web_pos_enabled === true;/.test(src('main/customerDisplayWire.ts')));
    ok('"The customer screen is a touch screen" — per PC, next to the Customer screen setup, a technician or settings.business',
      /data-testid="customer-screen-touch"/.test(src('renderer/components/CustomerScreenPanel.tsx')) && /handle\('customerDisplay:setTouch', async \(_e, p\) => \{\s*maySetUp\(\);/.test(ipc));
    ok('the POS offers "Ask the customer" only when main says it may (askable)', /\{askable\.allowed && \(/.test(src('renderer/components/SaleCustomer.tsx')));
    ok('the standard parts need no licence: the cashier\'s form and "Customer types it" are always there', /data-testid="sale-customer-types"/.test(src('renderer/components/SaleCustomer.tsx'))
      && !/askable\.allowed && \(\s*<button onClick=\{\(\) => setTypesIt/.test(src('renderer/components/SaleCustomer.tsx')));
  }

  console.log('\n6. The local schema, the sale, the receipt, the eTIMS flag');
  {
    const BR = 'br-1';
    const cloudState = { init: { products: [{ id: 'p-bread', name: 'Bread', base_price: 65, status: 'active', track_stock: false, category_id: null, description: null, image_url: null, has_variants: false, has_modifiers: false, branch_price: null, barcode: null, is_kitchen: null, show_days: null }],
      categories: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR, vatRate: 16, ctlRate: 0, maxDiscountPct: 50,
      businessType: 'minimart', businessName: 'Kifaru Mart', currency: 'KES', etimsEnabled: true } };
    srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'x-zaptill-server': '1' }); res.end(JSON.stringify(body)); };
      if (u.pathname === '/api/pos/init') return send(200, cloudState.init);
      if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff: [] });
      if (/\/api\/(inventory|tables|pumps|stations|staff)/.test(u.pathname)) return send(200, []);
      return send(200, {});
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const CLOUD = `http://127.0.0.1:${srv.address().port}`;
    const L = require(path.join(dist, 'localDb.js'));
    const db = L.getLocalDb();
    db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'r1', 'u-owner', 'biz-1', 'Kifaru Mart', '2026-10-28T00:00:00Z')`).run();
    const DC = require(path.join(dist, 'deviceConfig.js'));
    DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'POS 1', business_type: 'minimart' });
    require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
    const E = require(path.join(dist, 'syncEngine.js'));
    E.configureSyncEngine(CLOUD, 'tok', 'r1');
    const S = require(path.join(dist, 'shiftService.js'));
    const RB = require(path.join(dist, 'referenceBundle.js'));
    const required = Number((fs.readFileSync(path.join(desktop, '..', 'server', 'src', 'lib', 'desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
    const cols = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
    ok('local schema 78: orders.buyer_kra_pin; REQUIRED moves with it', L.LOCAL_SCHEMA_VERSION === 78 && required === 78 && cols.includes('buyer_kra_pin'),
      JSON.stringify({ v: L.LOCAL_SCHEMA_VERSION, required }));
    ok('DC getEtimsFlag: off until told', DC.getEtimsFlag() === false);
    await E.pullCatalogueNow();
    ok('the pull: eTIMS on (pos/init etimsEnabled) → the POS asks for the PIN', DC.getEtimsFlag() === true);
    cloudState.init = { ...cloudState.init }; delete cloudState.init.etimsEnabled;
    await E.pullCatalogueNow();
    ok('an older cloud (no key): kept', DC.getEtimsFlag() === true);
    const bundle = RB.buildReferenceBundle(db, {});
    ok('the branch server relays it to its POSs (and an older server says nothing → keep)', bundle.posInit?.etimsEnabled === true
      && RB.unpackNodeBundle(bundle).config.etimsEnabled === true && RB.unpackNodeBundle({ posInit: {} }).config.etimsEnabled === undefined);
    cloudState.init = { ...cloudState.init, etimsEnabled: false };
    await E.pullCatalogueNow();
    ok('turned off → off', DC.getEtimsFlag() === false);

    db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, 'u-cate', 'Cate', 'cashier', '{"orders.create":true}', ?, 'tok', '2026-10-28T06:00:00Z')`).run(BR);
    S.openShift(1000);
    let n = 0;
    const sale = (extra = {}) => ({ branch_id: BR, order_number: `T1-${++n}`, order_type: 'retail', subtotal: 65, vat_amount: 8.97, total: 65,
      items: [{ product: { id: 'p-bread', name: 'Bread', category_id: null }, unitPrice: 65, quantity: 1, lineTotal: 65, selectedVariants: [], selectedModifiers: [] }],
      payments: [{ method: 'cash', amount: 65, amount_tendered: 100, change_given: 35 }], ...extra });
    const row = (id) => db.prepare(`SELECT buyer_kra_pin, customer_name, customer_phone FROM orders WHERE id = ?`).get(id);
    const queued = (id) => JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id = ?`).get(id).payload);
    const s1 = E.createLocalOrder(sale({ customer_name: 'Mary', buyer_kra_pin: 'a123456789z' }));
    ok('a sale with the buyer\'s PIN: on the order row (upper case) and in the payload to the cloud',
      row(s1).buyer_kra_pin === 'A123456789Z' && queued(s1).buyer_kra_pin === 'A123456789Z' && queued(s1).customer_name === 'Mary', JSON.stringify([row(s1), queued(s1).buyer_kra_pin]));
    ok('…without "save" the phone is not on the sale (only the prompt had it)', row(s1).customer_phone === null && !('customer_phone' in queued(s1) && queued(s1).customer_phone));
    const s2 = E.createLocalOrder(sale({ buyer_kra_pin: 'not-a-pin' }));
    ok('a PIN that is not one is dropped — the sale is never held up by it', row(s2).buyer_kra_pin === null && !('buyer_kra_pin' in queued(s2)));
    const s3 = E.createLocalOrder(sale());
    ok('no PIN → none (as before)', row(s3).buyer_kra_pin === null && !('buyer_kra_pin' in queued(s3)));
    const P = require('@swiftpos/printing');
    const paper = (extra) => P.renderTicket({ business: { ...P.sampleBusiness }, station: P.receiptPreset('r', 'Receipt', 80),
      order: { billNumber: 'T1-1', orderType: 'counter', cashierName: 'Cate', soldAt: new Date(2026, 9, 28, 10, 0, 0), lines: [{ name: 'Bread', quantity: 1, unitPrice: 6500, lineTotal: 6500, units: [], stationIds: [] }],
        payments: [{ label: 'CASH', amount: 6500 }], changeGiven: 0, total: 6500, kotCount: 0, ...extra } }).blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : []));
    ok('the receipt prints "Buyer PIN: A123456789Z"; without one, no such line', paper({ buyerPin: 'A123456789Z' }).some((t) => t.includes('Buyer PIN: A123456789Z'))
      && !paper({}).some((t) => /Buyer PIN/.test(t)));
    ok('…the till\'s print path carries it (the payload → printSale → the receipt)', /buyerPin: {7}typeof payload\.buyer_kra_pin === 'string' \? payload\.buyer_kra_pin : undefined/.test(src('main/ipc/shared.ts'))
      && /\.\.\.\(sale\.buyerPin && \/\^\[AP\]\[0-9\]\{9\}\[A-Z\]\$\/\.test\(sale\.buyerPin\) \? \{ buyerPin: sale\.buyerPin \} : \{\}\)/.test(src('main/escposBridge.ts')));
  }

  console.log('\n7. The bundle');
  {
    let vite = null;
    try { vite = await import(pathToFileURL(require.resolve('vite', { paths: [desktop] })).href); } catch { /* not installed */ }
    if (!vite) console.log('  SKIPPED — vite is not installed here');
    else {
      const out = await vite.build({ root: desktop, configFile: path.join(desktop, 'vite.config.ts'), logLevel: 'silent', build: { write: false, emptyOutDir: false } });
      const chunks = (Array.isArray(out) ? out[0] : out).output.filter((o) => o.type === 'chunk');
      const main = chunks.find((c) => c.isEntry);
      const inMain = (rel) => Object.keys(main.modules).some((m) => m.split(path.sep).join('/').endsWith(`/src/${rel}`));
      console.log(`  (built: main chunk ${(main.code.length / 1024).toFixed(1)} kB)`);
      ok('the details panel, "Customer types it", the form, its keyboard and the M-Pesa prompt are NOT in the POS\'s main chunk',
        !['renderer/components/SaleCustomer.tsx', 'renderer/components/CustomerTypesIt.tsx', 'renderer/components/MpesaStkPanel.tsx', 'shared/CustomerAskForm.tsx', 'shared/customerDetails.ts'].some(inMain));
      ok('the POS\'s main chunk < 450 kB (lazy-load-a517) and ≤ 452 kB (petrol-pos-a588)', main.code.length < 450 * 1024 && main.code.length <= 452 * 1024, `${(main.code.length / 1024).toFixed(1)} kB`);
    }
  }
} finally {
  if (srv) srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
