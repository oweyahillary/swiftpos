// A606 — the customer screen: the cloud's half (the owner's slideshow, served with /api/pos/init) and the web POS's
// customer screen (a second browser window kept in step over a BroadcastChannel).
//
//   cd apps/server && npm run build && cd ../.. && TZ=UTC node --no-warnings tests/customer-screen-a606.test.mjs
//
// Owner, 2026-10-28: "Yesterday I saw a POS with two screens, one facing the client and the other for the cashier." The
// slideshow is premium (the online licence) and the owner's alone; up to 10 uploaded JPEG / PNG / WebP images, 3–60 s each.
//
// RUNS the shared rules as the cloud compiled them (lib/customerScreen.js, byte-identical to shared/ and every copy), the
// COMPILED server's routes behind the real requireAuth over HTTP with the database in memory (tests/lib-memdb.mjs), and
// the REAL dashboard publisher (lib/customerScreenChannel.ts) and view (lib/CustomerScreenView.tsx), bundled with esbuild.
//
//   L  the list rules: up to 10, uploaded images only (the image store's https address, .jpg / .png / .webp), duplicates
//      dropped, 3–60 seconds; a file picked: JPEG / PNG / WebP up to 2 MB; who: the owner, with the licence (emptying: no
//      licence needed).
//   R  the routes: the owner with the licence saves; a manager, a POS 403 OWNER_ONLY; no licence 403 ONLINE_LICENCE
//      (taking them down allowed); a bad list 400; GET says who may edit; the generic settings write refuses the key;
//      /pos/init serves the list (customerScreen) and the 'setup' change carries it.
//   W  the web customer screen: the POS posts the CLEANED state (no cost price, no cashier) and answers 'hello' with the
//      latest; the view draws idle (the name) → sale (the lines) → payment → thank you, and the premium parts only when
//      the gate let them through.
//
// MUTATIONS TO CONFIRM BITE (made by hand, each seen to fail, reverted — 2026-10-28):
//   - customerScreen.ts cleanCustomerScreen without the MAX_SLIDES check          → L "11 images refused" fails
//   - business.ts customerScreenWho owner always true                              → R "a manager … 403" fails
//   - customerScreen.ts customerScreenWriteError without the licence               → R "no licence 403" fails
//   - customerScreenChannel.ts posting the raw state (no sanitiseDisplayState)     → W "no cost price crosses" fails
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreRequire = createRequire(path.join(ROOT, 'apps/server/package.json'));   // @zaptill/core, as the cloud loads it
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/pos.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const state = require(path.join(DIST, 'lib/permissionsState.js'));
const SV = require(path.join(DIST, 'lib/syncVersions.js'));
const AC = require(path.join(DIST, 'lib/authCache.js'));
const PI = require(path.join(DIST, 'lib/posInit.js'));
const SC = require(path.join(DIST, 'lib/syncChanges.js'));
const CS = coreRequire('@zaptill/core/customerScreen');   // shared-components batch E: packages/core
const TOPICS = coreRequire('@zaptill/core/syncTopics');
const warn = console.warn; console.warn = () => {};
const err = console.error; console.error = () => {};

const B = '11111111-1111-4111-8111-111111111111';
const BR = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MANAGER = 'aaaaaaaa-0000-4000-8000-000000000002';
const perms = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
const IMG = (n, ext = 'jpg') => `https://res.cloudinary.com/zaptill/image/upload/v1730000000/slides/offer-${n}.${ext}`;
const reset = ({ licensed = true, slides = null } = {}) => {
  mem.calls = []; mem.fail = () => null;
  SV._resetSyncVersions(); AC._resetAuthCache(); PI._resetInitCache(); SC._resetSyncChanges();
  mem.db = {
    businesses: [{ id: B, owner_id: OWNER, name: 'Kifaru Mart', type: 'retail', currency: 'KES', vat_rate: 16, ctl_rate: 0, status: 'active', web_access_expires_at: null }],
    branches: [{ id: BR, business_id: B, name: 'Westlands', is_main: true, desktop_licensed: true }],
    users: [{ id: OWNER, name: 'Owner', status: 'active', business_id: B, permissions_version: 0, roles: { name: 'Admin' }, user_branches: [], user_permissions: [] },
      { id: MANAGER, name: 'Njeri', status: 'active', business_id: B, permissions_version: 0, role_id: 'role-m', roles: perms('Manager', 'receipt.manage', 'settings.business', 'settings.manage'), user_branches: [{ branch_id: BR }], user_permissions: [] }],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: BR, user_id: OWNER }],
    sync_versions: [{ business_id: B, topic: 'catalogue', version: 7 }],
    feature_flags: licensed ? [{ business_id: B, key: 'web_hosting', enabled: true }] : [],
    cloud_plans: [],
    business_branding: [], branch_branding: [],
    categories: [], products: [], branch_prices: [], tables: [], branch_settings: [], payment_methods: [], offers: [],
    business_settings: slides ? [{ id: 'bs-cs', business_id: B, key: 'customer_screen', value: JSON.stringify(slides) }] : [],
    promotions: [], stock_takes: [], variant_groups: [], modifier_groups: [], combo_items: [], menus: [], sync_changes: [],
    sync_change_floor: [{ id: 1, floor_seq: 0 }], change_requests: [], refresh_tokens: [], audit_log: [], notifications: [], admin_users: [], ops_events: [],
  };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, branchId: BR, isOwner: false, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TK = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'], surface: 'dashboard' }),
  manager: sign({ userId: MANAGER, permissionKeys: ['receipt.manage', 'settings.business', 'settings.manage'], surface: 'dashboard' }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const stored = () => { const r = mem.db.business_settings.find((x) => x.key === 'customer_screen'); return r ? JSON.parse(r.value) : null; };

try {
  state._setPermissionsMigrated(true);

  console.log('\nL. the list rules\n');
  await ok('a clean list: in order, duplicates dropped, seconds kept (default 8)', async () => {
    const c = CS.cleanCustomerScreen({ slides: [{ url: IMG(1) }, IMG(2, 'png'), { url: IMG(1) }, { url: IMG(3, 'webp') }], seconds: 12 });
    assert.equal(c.ok, true, c.error);
    assert.deepEqual(c.value, { slides: [{ url: IMG(1) }, { url: IMG(2, 'png') }, { url: IMG(3, 'webp') }], seconds: 12 });
    assert.equal(CS.cleanCustomerScreen({ slides: [] }).value.seconds, 8);
  });
  await ok('11 images refused; 10 accepted', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ url: IMG(i) }));
    assert.equal(CS.cleanCustomerScreen({ slides: eleven }).ok, false);
    assert.equal(CS.cleanCustomerScreen({ slides: eleven.slice(0, 10) }).ok, true);
  });
  await ok('only uploaded JPEG / PNG / WebP images: http, another host, a GIF, an SVG, a query string, a script refused', async () => {
    for (const bad of ['http://res.cloudinary.com/z/image/upload/a.jpg', 'https://evil.example/image/upload/a.jpg',
      'https://res.cloudinary.com/z/image/upload/a.gif', 'https://res.cloudinary.com/z/image/upload/a.svg',
      'https://res.cloudinary.com/z/image/upload/a.jpg?x=1', 'javascript:alert(1)//.jpg', 'https://res.cloudinary.com/z/image/upload/"onload=.png', 42]) {
      assert.equal(CS.cleanCustomerScreen({ slides: [{ url: bad }] }).ok, false, String(bad));
    }
  });
  await ok('seconds 3–60, whole numbers', async () => {
    for (const s of [2, 61, 4.5, 'x']) assert.equal(CS.cleanCustomerScreen({ slides: [], seconds: s }).ok, false, String(s));
    for (const s of [3, 60, '10']) assert.equal(CS.cleanCustomerScreen({ slides: [], seconds: s }).ok, true, String(s));
  });
  await ok('a file picked: JPEG / PNG / WebP up to 2 MB', async () => {
    assert.equal(CS.slideFileError({ type: 'image/jpeg', size: 500_000 }), null);
    assert.equal(CS.slideFileError({ type: 'image/webp', size: 2 * 1024 * 1024 }), null);
    assert.match(CS.slideFileError({ type: 'image/png', size: 2 * 1024 * 1024 + 1 }), /2 MB/);
    assert.match(CS.slideFileError({ type: 'image/gif', size: 1000 }), /JPEG, PNG or WebP/);
    assert.match(CS.slideFileError({ type: 'image/svg+xml', size: 1000 }), /JPEG, PNG or WebP/);
  });
  await ok('who: the owner with the licence; emptying needs no licence; never someone else', async () => {
    assert.equal(CS.customerScreenWriteError({ owner: true, licensed: true }, false), null);
    assert.equal(CS.customerScreenWriteError({ owner: true, licensed: false }, true), null);
    assert.equal(CS.customerScreenWriteError({ owner: true, licensed: false }, false)?.code, 'ONLINE_LICENCE');
    assert.equal(CS.customerScreenWriteError({ owner: false, licensed: true }, true)?.code, 'OWNER_ONLY');
  });
  await ok('what a POS stores: bad entries dropped, never more than 10, a broken value → none', async () => {
    const w = CS.slidesFromWire(JSON.stringify({ slides: [IMG(1), 'https://evil.example/x.jpg', ...Array.from({ length: 12 }, (_, i) => IMG(i + 2))], seconds: 99 }));
    assert.equal(w.slides.length, 10); assert.equal(w.slides[0].url, IMG(1)); assert.equal(w.seconds, 8);
    assert.equal(CS.slidesFromWire('{oops'), null); assert.equal(CS.slidesFromWire(null), null);
  });

  console.log('\nR. the routes\n');
  await ok('the owner with the licence saves the list (stored cleaned, as JSON)', async () => {
    reset();
    const r = await call('PUT', '/api/business/customer-screen', TK.owner, { slides: [{ url: IMG(1) }, { url: IMG(2, 'png') }], seconds: 10 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(stored(), { slides: [{ url: IMG(1) }, { url: IMG(2, 'png') }], seconds: 10 });
    const g = await call('GET', '/api/business/customer-screen', TK.owner);
    assert.equal(g.status, 200, g.text);
    assert.deepEqual([g.body.slides.length, g.body.seconds, g.body.editable, g.body.licensed], [2, 10, true, true]);
  });
  await ok('a manager, a POS: 403 OWNER_ONLY (nothing stored); GET says they may not edit', async () => {
    reset();
    for (const t of [TK.manager, TK.till]) {
      const r = await call('PUT', '/api/business/customer-screen', t, { slides: [{ url: IMG(1) }] });
      assert.equal(r.status, 403, r.text); assert.equal(r.body.code, 'OWNER_ONLY');
    }
    assert.equal(stored(), null);
    const g = await call('GET', '/api/business/customer-screen', TK.manager);
    assert.equal(g.body.editable, false);
  });
  await ok('no licence: 403 ONLINE_LICENCE; taking the images down is still allowed', async () => {
    reset({ licensed: false, slides: { slides: [{ url: IMG(1) }], seconds: 8 } });
    let r = await call('PUT', '/api/business/customer-screen', TK.owner, { slides: [{ url: IMG(2) }] });
    assert.equal(r.status, 403, r.text); assert.equal(r.body.code, 'ONLINE_LICENCE');
    r = await call('PUT', '/api/business/customer-screen', TK.owner, { slides: [] });
    assert.equal(r.status, 200, r.text); assert.deepEqual(stored().slides, []);
  });
  await ok('a bad list: 400 (11 images, a GIF, 2 seconds)', async () => {
    reset();
    for (const body of [{ slides: Array.from({ length: 11 }, (_, i) => ({ url: IMG(i) })) }, { slides: [{ url: IMG(1, 'gif') }] }, { slides: [], seconds: 2 }]) {
      const r = await call('PUT', '/api/business/customer-screen', TK.owner, body);
      assert.equal(r.status, 400, r.text);
    }
  });
  await ok('the generic settings write refuses the key (its own rules are on its own route)', async () => {
    reset();
    const r = await call('POST', '/api/business/settings', TK.owner, { key: 'customer_screen', value: { slides: [{ url: 'https://evil.example/x.jpg' }] } });
    assert.equal(r.status, 400, r.text); assert.equal(r.body.code, 'USE_CUSTOMER_SCREEN'); assert.equal(stored(), null);
  });
  await ok('/pos/init serves the list as customerScreen (null when none); the setup change carries it', async () => {
    reset({ slides: { slides: [{ url: IMG(1) }, { url: 'https://evil.example/x.jpg' }], seconds: 15 } });
    let r = await call('GET', `/api/pos/init?branch_id=${BR}`, TK.till);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.customerScreen, { slides: [{ url: IMG(1) }], seconds: 15 });
    reset();
    r = await call('GET', `/api/pos/init?branch_id=${BR}`, TK.till);
    assert.equal(r.body.customerScreen, null);
    assert.ok(TOPICS.CONFIG_KEYS.setup.includes('customerScreen'));
    assert.equal(TOPICS.settingTopic('customer_screen'), 'setup');
  });

  console.log('\nW. the web customer screen\n');
  const esbuild = createRequire(path.join(ROOT, 'apps/dashboard/package.json'))('esbuild');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a606-web-'));
  const entry = path.join(tmp, 'entry.tsx');
  const dash = (p) => path.join(ROOT, 'apps/dashboard/src', p).replace(/\\/g, '/');
  fs.writeFileSync(entry, `export { createPublisher } from ${JSON.stringify(dash('lib/customerScreenChannel.ts'))};
export { default as View } from ${JSON.stringify(path.join(ROOT, 'packages/ui/src/CustomerScreenView.tsx').replace(/\\/g, '/'))};
export * as CS from ${JSON.stringify(path.join(ROOT, 'packages/core/src/customerScreen.ts').replace(/\\/g, '/'))};
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';`);
  const nodePaths = [path.join(ROOT, 'apps/dashboard/node_modules'), path.join(ROOT, 'node_modules')];
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, 'web.cjs'), logLevel: 'silent',
    jsx: 'automatic', nodePaths, define: { 'process.env.NODE_ENV': '"production"' } });
  const W = createRequire(import.meta.url)(path.join(tmp, 'web.cjs'));
  const html = (props) => W.renderToStaticMarkup(W.createElement(W.View, props));
  const content = (o = {}) => W.CS.gateDisplayContent({ businessName: 'Kifaru Mart', themeId: null, logo: null, primaryHex: null, secondaryHex: null,
    accentHex: null, licensed: false, slides: null, mpesa: null, ...o });

  await ok('the publisher posts the CLEANED state (no cost price, no cashier crosses), stamps its stage, answers hello', async () => {
    const posted = [];
    const ch = { postMessage: (m) => posted.push(m), close() {}, onmessage: null };
    let clock = 5000;
    const pub = W.createPublisher(ch, () => clock);
    const raw = { stage: 'sale', mode: 'retail', currency: 'KES', lines: [{ name: 'Milk 500ml', qty: 2, unitPrice: 60, lineTotal: 120, cost_price: 41, supplier: 'Brookside' }],
      subtotal: 120, total: 120, cashier: 'Njeri', staff_id: 'u-9', pin: '1234', customer: { name: 'Wanjiru', phone: '0712' } };
    pub.content(content());
    const st = pub.state(raw);
    const j = JSON.stringify(posted);
    for (const leak of ['cost_price', '41', 'Brookside', 'Njeri', 'u-9', '1234', 'Wanjiru', '0712']) assert.ok(!j.includes(leak), `"${leak}" crossed`);
    assert.equal(st.lines[0].name, 'Milk 500ml'); assert.equal(st.since, 5000);
    clock = 9000; assert.equal(pub.state({ ...raw, total: 180 }).since, 5000, 'same stage keeps its start');
    assert.equal(pub.state({ ...raw, stage: 'payment' }).since, 9000, 'a new stage starts now');
    const n = posted.length;
    ch.onmessage({ data: { type: 'hello' } });
    assert.deepEqual(posted.slice(n).map((m) => m.type), ['content', 'state'], 'hello answered with the latest');
    assert.equal(posted[posted.length - 1].state.stage, 'payment');
  });
  await ok('the view: idle shows the name plainly (no logo, no slides without premium)', async () => {
    const out = html({ state: W.CS.idleState('retail'), content: content({ logo: 'data:image/png;base64,AAAA' }), slides: [] });
    assert.ok(out.includes('data-testid="cs-idle"') && out.includes('Kifaru Mart') && out.includes('Welcome'));
    assert.ok(!out.includes('class="cs-logo"') && !out.includes('data-testid="cs-slides"'));
  });
  await ok('the view: a sale — the lines, the offer, the total; a payment by cash — given and change; thank you → idle after 8 s', async () => {
    const sale = W.CS.sanitiseDisplayState({ stage: 'sale', mode: 'retail', currency: 'KES', since: 1000,
      lines: [{ name: 'Bread', qty: 1, unitPrice: 65, lineTotal: 65 }, { name: 'Sugar 1kg', qty: 2, unitPrice: 180, lineTotal: 360, discount: 20 }],
      subtotal: 425, discount: 20, total: 405, amountDue: 405 });
    let out = html({ state: sale, content: content(), slides: [] });
    assert.equal((out.match(/data-testid="cs-line"/g) ?? []).length, 2);
    assert.ok(out.includes('Your items') && out.includes('405.00') && out.includes('Offer −20.00') && out.includes('2 × 180.00'));
    const pay = W.CS.sanitiseDisplayState({ ...sale, stage: 'payment', method: 'cash', paid: 500, change: 95 });
    out = html({ state: pay, content: content(), slides: [] });
    assert.ok(out.includes('To pay') && out.includes('data-testid="cs-cash"') && out.includes('500.00') && out.includes('95.00'));
    const thanks = W.CS.sanitiseDisplayState({ stage: 'thanks', mode: 'retail', currency: 'KES', total: 405, amountDue: 405, change: 95, since: 1000 });
    out = html({ state: thanks, content: content(), slides: [], now: 1000 + 7999 });
    assert.ok(out.includes('data-testid="cs-thanks"') && out.includes('Your change') && !out.includes('Sugar'));
    out = html({ state: thanks, content: content(), slides: [], now: 1000 + 8000 });
    assert.ok(out.includes('data-testid="cs-idle"'));
  });
  await ok('the view: premium — the logo with themes, the slideshow and M-Pesa with the licence; never without', async () => {
    const premium = content({ themeId: 'ocean', logo: 'data:image/png;base64,AAAA', primaryHex: '#e11d48', licensed: true,
      slides: { slides: [{ url: IMG(1) }, { url: IMG(2) }], seconds: 6 }, mpesa: { kind: 'paybill', number: '4098201', account: 'SHOP 12' } });
    let out = html({ state: W.CS.idleState('retail'), content: premium, slides: premium.slides.map((s) => s.url) });
    assert.ok(out.includes('data-testid="cs-slides"') && out.includes(IMG(1)) && out.includes('class="cs-logo"'));
    const pay = W.CS.sanitiseDisplayState({ stage: 'payment', mode: 'retail', currency: 'KES', method: 'mpesa', lines: [], total: 300, amountDue: 300 });
    out = html({ state: pay, content: premium, slides: [] });
    assert.ok(out.includes('data-testid="cs-mpesa"') && out.includes('4 098 201') && out.includes('SHOP 12') && out.includes('Business number'));
    out = html({ state: pay, content: content({ mpesa: { kind: 'buy_goods', number: '123456', account: null } }), slides: [] });
    assert.ok(!out.includes('data-testid="cs-mpesa"'), 'no M-Pesa panel without the licence');
    assert.equal(content({ licensed: false, slides: { slides: [{ url: IMG(1) }], seconds: 6 } }).slides.length, 0);
    assert.equal(content({ themeId: null, primaryHex: '#e11d48', logo: 'data:image/png;base64,AAAA' }).brand, null);
  });
} finally {
  server.close();
  console.warn = warn; console.error = err;
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
