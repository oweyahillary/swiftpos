// Courses on the desktop POS (owner, 2026-11-04: "1-5 yes only if the web licence is active").
//
// A restaurant with the online licence gets the web POS's courses on the desktop: a course per cart line (Starters,
// Mains, Desserts, Drinks), Held / Fires now, and "Fire <course>". A held line is not on a kitchen ticket until its course
// is fired (or the bill is paid — what is paid for always reaches the kitchen); firing prints it, under the course's
// heading. An order without courses is sent and printed exactly as before.
//
// Drives the REAL compiled dist/main for the tickets: ipc/shared.ts's queueThermal (what escpos:printProduction and
// order:create call) → escposBridge.printSale → shared/printing's render, on a REAL SQLite file, electron shimmed; only
// the spool is stood in for. The rules are packages/core/src/courses.ts, run directly.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/courses-desktop.test.mjs
//   (OLD_PRINTING=<a build of shared/printing from before courses> also compares every ticket byte for byte with it.)
//
//   C  the rules: a course starts held, Fires now / Held, which courses wait, firing one, courses off = nothing held.
//   K  the tickets: no course → no course on any ticket line and no heading (bytes unchanged); with courses → the dishes
//      with no course first, then each course's together under one heading, on the kitchen and dispatch tickets; the
//      receipt never shows one and its bytes are the same with or without courses.
//   S  the sale screen: Send leaves held lines off; the charge sends them; Fire sends that course; the ledger records
//      only what was sent; the kitchen-void rules are the desktop's (a held line was never sent: no void); only for a
//      restaurant with the online licence; a held tab keeps its courses (the cart is saved whole).
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - courses.ts withCourse starting a line 'fired'                       → C "a course starts held"
//   - courses.ts isHeld ignoring coursesOn                                → C "courses off"
//   - render.ts printing the heading for every line (course or not)       → K "no course"
//   - render.ts linesByCourse returning the lines as they are             → K "a dish with no course comes first"
//   - escposBridge.ts dropping the course                                 → K "a heading above each course"
//   - POSPage's send filter without !isHeld                               → S "Send leaves held lines off"
//   - POSPage's coursesOn without onlineLicence                           → S "only with the online licence"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-courses-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.24' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const PW = require(path.join(dist, 'print', 'printWorker.js'));
const B = require(path.join(dist, 'escposBridge.js'));
const { createIpcShared } = require(path.join(dist, 'ipc', 'shared.js'));
const P = require('@swiftpos/printing');
const OLD = process.env.OLD_PRINTING ? require(process.env.OLD_PRINTING) : null;
const K = await import(pathToFileURL(path.join(here, '..', '..', '..', 'packages', 'core', 'src', 'courses.ts')).href);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 1500)}`); fail++; } };

console.log('\nC. the rules\n');
{
  const line = { quantity: 1, sentQty: 0 };
  const m = K.withCourse(line, 'Mains');
  ok('a course starts held', m.course === 'Mains' && m.fire_status === 'held', JSON.stringify(m));
  ok('Fires now / Held', K.toggledHold(m).fire_status === 'fired' && K.toggledHold(K.toggledHold(m)).fire_status === 'held');
  ok('no course: sent with the order (fired), and a toggle does nothing', K.withCourse(m, '').course === null && K.withCourse(m, '').fire_status === 'fired' && K.toggledHold(line) === line);
  ok('only the four courses', K.cleanCourse(' Desserts ') === 'Desserts' && K.cleanCourse('Soup') === null && K.cleanCourse(5) === null);
  const cart = [K.withCourse({ quantity: 1 }, 'Mains'), { quantity: 2 }, K.withCourse({ quantity: 1 }, 'Starters'), K.toggledHold(K.withCourse({ quantity: 1 }, 'Desserts'))];
  ok('which courses wait, in the menu\'s order', JSON.stringify(K.heldCourses(cart, true)) === '["Starters","Mains"]', JSON.stringify(K.heldCourses(cart, true)));
  const fired = K.firedCourse(cart, 'Mains');
  ok('firing a course fires only its held lines', fired[0].fire_status === 'fired' && fired[2].fire_status === 'held' && fired[1] === cart[1]);
  ok('courses off (no licence, not a restaurant): nothing is held', !K.isHeld(cart[0], false) && K.heldCourses(cart, false).length === 0 && K.isHeld(cart[0], true));
}

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, currency, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', 'KES', '2026-11-04T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
B.setEscposEnabled(true);
db.prepare(`INSERT INTO print_stations (id, name, kind, sort_order, active) VALUES ('st-k', 'Kitchen', 'kitchen', 1, 1), ('st-d', 'Dispatch', 'dispatch', 2, 1), ('st-r', 'POS', 'receipt', 3, 1)`).run();
db.prepare(`INSERT INTO category_stations (category_id, station_id) VALUES ('c-food', 'st-k')`).run();
const queued = [];
PW.queueTickets = (contexts, stations) => { queued.push({ contexts, stations }); return { queued: stations.map((s) => s.id), skipped: [], failed: [] }; };
PW.assignments = () => ['st-k', 'st-d', 'st-r'].map((id, i) => ({ stationId: id, target: `tcp://10.0.0.${5 + i}:9100`, paperWidthMm: 80 }));
const { queueThermal } = createIpcShared(() => {});

const product = (id, name, category_id = 'c-food') => ({ id, name, category_id, categories: null, description: null });
const line = (id, name, qty, price, extra = {}) => ({ product: product(id, name), unitPrice: price, quantity: qty, lineTotal: qty * price,
  selectedVariants: [], selectedModifiers: [], notes: null, ...extra });
const plain = [line('p-soup', 'Soup', 2, 300), line('p-steak', 'Steak', 1, 1200, { notes: 'Medium' }), line('p-cake', 'Cake', 1, 400)];
const coursed = [line('p-soup', 'Soup', 2, 300, { course: 'Starters' }), line('p-steak', 'Steak', 1, 1200, { notes: 'Medium', course: 'Mains' }),
  line('p-fish', 'Fish', 1, 1100, { course: 'Mains' }), line('p-bread', 'Bread', 1, 100)];
const tickets = (items, kinds, extra = {}) => {
  queued.length = 0;
  queueThermal({ order_number: 'T1-4001', order_type: 'dine_in', table_number: '7', cashier_name: 'Cate', items, notes: null, ...extra }, kinds);
  const entry = queued[0];
  const at = (kind, R = P) => {
    const station = entry.stations.find((s) => s.kind === kind);
    return R.renderTicket({ ...entry.contexts[0], station });
  };
  return { ctx: entry.contexts[0], at };
};
const text = (doc) => P.toPreview(doc).split('\n').map((x) => x.replace(/\s+$/, ''));
const bytes = (doc, R = P) => Buffer.from(R.toEscPos(doc));

console.log('\nK. the tickets\n');
{
  const t = tickets(plain, ['kitchen', 'dispatch']);
  ok('no course: no ticket line carries a course', t.ctx.order.lines.every((l) => !('course' in l)), JSON.stringify(t.ctx.order.lines));
  const k = text(t.at('kitchen'));
  ok('no course: no heading on the kitchen or dispatch ticket', !k.some((x) => /^-- .* --$/.test(x)) && !text(t.at('dispatch')).some((x) => /^-- .* --$/.test(x)), k.join('\n'));
  if (OLD) {
    for (const kind of ['kitchen', 'dispatch']) {
      ok(`no course: the ${kind} ticket's bytes equal the renderer from before courses`, Buffer.compare(bytes(t.at(kind)), bytes(t.at(kind, OLD), OLD)) === 0);
    }
  }
}
{
  const t = tickets(coursed, ['kitchen', 'dispatch']);
  const k = text(t.at('kitchen'));
  console.log(k.join('\n'));
  const at = (s) => k.indexOf(s);
  ok('a heading above each course\'s first dish', at('-- STARTERS --') >= 0 && at('-- STARTERS --') < at('2   SOUP') && at('-- MAINS --') > at('2   SOUP') && at('-- MAINS --') < at('1   STEAK'), k.join('\n'));
  ok('one heading per course (two Mains dishes, one heading)', k.filter((x) => x === '-- MAINS --').length === 1, k.join('\n'));
  ok('a dish with no course comes first, under no heading', at('1   BREAD') >= 0 && at('1   BREAD') < at('-- STARTERS --') && !k.some((x) => /^-- (?!STARTERS|MAINS)/.test(x)), k.join('\n'));
  ok('the dispatch ticket shows the courses too', text(t.at('dispatch')).includes('-- MAINS --'));
  if (OLD) {
    ok('the old renderer ignores the course (the field is new)', !text(t.at('kitchen', OLD)).includes('-- MAINS --'));
  }
}
{
  const pay = { total: 3000, payments: [{ method: 'cash', amount: 3000 }] };
  const a = tickets(coursed, ['receipt'], pay);
  const b = tickets(coursed.map(({ course, ...rest }) => rest), ['receipt'], pay);
  ok('the receipt never shows a course', !text(a.at('receipt')).some((x) => /STARTERS|MAINS/.test(x)));
  ok('the receipt\'s bytes are the same with or without courses', Buffer.compare(bytes(a.at('receipt')), bytes(b.at('receipt'))) === 0);
}

console.log('\nS. the sale screen\n');
{
  const p = src('renderer/pages/POSPage.tsx');
  ok('courses only for a restaurant with the online licence', /const coursesOn = flags\.isRestaurant && onlineLicence;/.test(p));
  ok('Send to kitchen leaves held lines off; the charge (atPayment) sends them',
    /withIds\.filter\(i => unsentQtyOf\(i\) > 0 && \(atPayment \|\| !isHeld\(i, coursesOn\)\)\)/.test(p));
  ok('the Send count leaves held lines out', /const unsentCount = cart\.filter\(i => unsentQtyOf\(i\) > 0 && !isHeld\(i, coursesOn\)\)\.length;/.test(p));
  ok('Fire <course> sends from the cart with that course fired',
    /const next = firedCourse\(cart, course\);\s+setCart\(next\);\s+void handleSendToKitchen\(false, next\);/.test(p));
  ok('the charge still sends what is left of a sent order', /if \(someSent && cart\.some\(i => unsentQtyOf\(i\) > 0\)\) await handleSendToKitchen\(true\);/.test(p));
  ok('the ledger records only what was sent', /lines: unsent\.map\(\(\{ item, qty \}\) => linePayload\(item, qty\)\)/.test(p));
  ok('the ticket line carries the course (only a line that has one)', (p.match(/\.\.\.\(item\.course \? \{ course: item\.course \} : \{\}\)/g) ?? []).length === 2);
  ok('the course picker and Held / Fires now only with courses on, while some of the line is still to send',
    /\{coursesOn && maySend && !item\.isFuel && unsentQtyOf\(item\) > 0 && \(\s+<div className="flex items-center gap-2" data-testid="line-course">/.test(p));
  ok('a Fire button per held course, where the order may be sent', /\{maySend && heldCourses\(cart, coursesOn\)\.length > 0 && \(/.test(p));
  ok('the kitchen-void rules are unchanged: only a SENT line asks for a void', /const sent = sentQtyOf\(item\);/.test(p) && /setKitchenVoid\(/.test(p));
  ok('a held tab keeps its courses (the cart line type carries them; the tab saves the cart whole)',
    /course\?: string \| null;\s+fire_status\?: FireStatus \| null;/.test(src('renderer/lib/cart.ts')) && /cart, deliveryPerson:/.test(p));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
