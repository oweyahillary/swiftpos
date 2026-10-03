// A367 (desktop 0.6.24, schema 58) — notes on an item and on the whole order, on the till.
//
// Owner, 2026-09-30: "can we add notes in the order maybe if a customer wants a mixture of 3 normal and 2 spicy chicken
// pieces or they want exta cheese if it pizza or no salt etc". Decided: free text + quick picks the owner sets; a note on
// each line and one on the order; notes are free (anything priced stays a modifier).
//
// Drives the REAL compiled dist/main (localDb, syncEngine.createLocalOrder, deviceConfig, referenceBundle, webSales) on a
// REAL SQLite file, electron shimmed; runs the shared rules (src/shared/orderNotes.ts, type-stripped); pins the screen.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/order-notes.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - createLocalOrder writes the line note raw (no cleanNote)        → "cleaned: …" fails
//   - the order's note left out of the INSERT                         → "the order's note is stored" fails
//   - setOrderNotePicks writing on undefined                          → "an older cloud … keeps" fails
//   - unpackNodeBundle dropping noteQuickPicks                        → "a peer takes the node's picks" fails
//   - POSPage's plain tap merging into a line with a note             → "a tap never joins …" fails
//   - parseNotePicks returning the defaults for a saved []            → "a saved empty list means none" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.ORDER_NOTES_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, ORDER_NOTES_TS: '1' } });
  process.exit(r.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(desktop, p), 'utf8');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a367-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const R = require(path.join(dist, 'referenceBundle.js'));
const W = require(path.join(dist, 'webSales.js'));
const N = await import(pathToFileURL(path.join(desktop, 'src/shared/orderNotes.ts')).href);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

console.log('A367 — notes on an item and on the order (till)\n');

// ── The shared rules ─────────────────────────────────────────────────────────
ok('cleanNote: trimmed, spaces squeezed, typed lines kept, blank lines dropped',
  N.cleanNote('  3  normal \r\n\n  2 spicy ') === '3 normal\n2 spicy', JSON.stringify(N.cleanNote('  3  normal \r\n\n  2 spicy ')));
ok('cleanNote: nothing but spaces → null', N.cleanNote('  \n ') === null && N.cleanNote(null) === null);
ok('cleanNote: cut at the limit, never refused', N.cleanNote('x'.repeat(500)).length === N.ITEM_NOTE_MAX
  && N.cleanNote('y'.repeat(500), N.ORDER_NOTE_MAX).length === N.ORDER_NOTE_MAX);
ok('parseNotePicks: unset → the defaults', JSON.stringify(N.parseNotePicks(null)) === JSON.stringify(N.DEFAULT_NOTE_PICKS)
  && N.parseNotePicks('').length === N.DEFAULT_NOTE_PICKS.length);
ok('parseNotePicks: a saved empty list means none', N.parseNotePicks('[]').length === 0 && N.parseNotePicks([]).length === 0);
ok('parseNotePicks: trimmed, de-duplicated in any case, blanks dropped',
  JSON.stringify(N.parseNotePicks(['No salt', ' no SALT ', '', 'Extra cheese'])) === '["No salt","Extra cheese"]');
ok('parseNotePicks: plain text one per line also reads', JSON.stringify(N.parseNotePicks('Spicy\nMild')) === '["Spicy","Mild"]');
ok('parseNotePicks: capped', N.parseNotePicks(Array.from({ length: 40 }, (_, i) => `p${i}`)).length === N.PICKS_MAX);
ok('togglePick adds a pick on its own line, and a second tap takes it off',
  N.togglePick('3 normal', 'Spicy') === '3 normal\nSpicy' && N.togglePick('3 normal\nspicy', 'Spicy') === '3 normal');
ok('hasPick matches a whole line only', N.hasPick('No salt\nSpicy', 'spicy') && !N.hasPick('Not spicy', 'Spicy'));
ok('noteLines: the printed / on-screen rows', JSON.stringify(N.noteLines('3 normal\n2 spicy')) === '["» 3 normal","» 2 spicy"]'
  && N.noteLines(null).length === 0);

// ── Schema 58 ────────────────────────────────────────────────────────────────
const db = L.getLocalDb();
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
ok('local schema 58+: orders.notes, order_items.notes, held_orders.order_note, device_config.order_note_picks',
  L.LOCAL_SCHEMA_VERSION >= 58 && cols('orders').includes('notes') && cols('order_items').includes('notes')
  && cols('held_orders').includes('order_note') && cols('device_config').includes('order_note_picks'));

// ── A sale with notes ────────────────────────────────────────────────────────
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B', '2026-09-30T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-test', 'Test Cashier')`).run();
db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-test', 'Test Cashier', 'cashier', '{}', 'br-1', 'tok', '2026-09-30T06:00:00Z')`).run();
db.prepare(`INSERT INTO products (id, name, base_price, status) VALUES ('p-chk', 'Chicken Piece', 250, 'active'), ('p-piz', 'Pizza', 900, 'active')`).run();
S.openShift(1000);

const orderId = E.createLocalOrder({
  branch_id: 'br-1', order_number: 'T1-0001', order_type: 'takeaway',
  subtotal: 2150, vat_amount: 0, total: 2150,
  items: [
    { product: { id: 'p-chk', name: 'Chicken Piece' }, unitPrice: 250, quantity: 5, lineTotal: 1250, notes: '  3 normal \n\n 2 spicy ' },
    { product: { id: 'p-piz', name: 'Pizza' }, unitPrice: 900, quantity: 1, lineTotal: 900, notes: '   ' },
  ],
  notes: ' Deliver to gate B ',
  payments: [{ method: 'cash', amount: 2150 }],
});
const items = db.prepare(`SELECT product_id, notes FROM order_items WHERE order_id=? ORDER BY product_id`).all(orderId);
ok('cleaned: the line note is stored as typed lines ("3 normal" / "2 spicy")',
  items.find((i) => i.product_id === 'p-chk')?.notes === '3 normal\n2 spicy', JSON.stringify(items));
ok('a blank line note is stored as NULL', items.find((i) => i.product_id === 'p-piz')?.notes === null);
ok('the order\'s note is stored', db.prepare(`SELECT notes FROM orders WHERE id=?`).get(orderId)?.notes === 'Deliver to gate B');
const queued = JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id=?`).get(orderId).payload);
ok('the push to the cloud carries both (items[].notes, notes)',
  queued.notes === ' Deliver to gate B ' && queued.items[0].notes === '  3 normal \n\n 2 spicy ', JSON.stringify(queued.items[0]));
ok('a note never changes the money: the total is what was charged', db.prepare(`SELECT total FROM orders WHERE id=?`).get(orderId)?.total === 2150);

// ── The owner's quick picks ──────────────────────────────────────────────────
const picksNow = () => N.parseNotePicks(C.getDeviceConfig()?.order_note_picks ?? null);
ok('never told → the defaults', JSON.stringify(picksNow()) === JSON.stringify(N.DEFAULT_NOTE_PICKS));
C.setOrderNotePicks(['Extra cheese', 'No salt']);
ok('the pull caches the owner\'s list', JSON.stringify(picksNow()) === '["Extra cheese","No salt"]');
C.setOrderNotePicks(undefined);
ok('an older cloud (nothing said) keeps the cached list', JSON.stringify(picksNow()) === '["Extra cheese","No salt"]');
C.setOrderNotePicks([]);
ok('the owner cleared the list → no quick picks', picksNow().length === 0);
C.setOrderNotePicks(['Spicy']);
ok('saveDeviceConfig never wipes the cached picks', (C.saveDeviceConfig({ device_name: 'Front 2' }), JSON.stringify(picksNow()) === '["Spicy"]'));

ok('a peer takes the node\'s picks (bundle unpacked)',
  JSON.stringify(R.unpackNodeBundle({ posInit: { noteQuickPicks: ['Mild'] } }).config.noteQuickPicks) === '["Mild"]'
  && R.unpackNodeBundle({ posInit: {} }).config.noteQuickPicks === undefined);
const fakeDb = { prepare: () => ({ all: () => [] }) };
ok('the node serves its cached picks to peers',
  JSON.stringify(R.buildReferenceBundle(fakeDb, { order_note_picks: '["Spicy","Mild"]' }).posInit.noteQuickPicks) === '["Spicy","Mild"]'
  && R.buildReferenceBundle(fakeDb, {}).posInit.noteQuickPicks === null);

// ── A web sale on this till's drawer keeps its notes ─────────────────────────
const shift = db.prepare(`SELECT id, business_id, branch_id FROM shifts WHERE status='open'`).get();
W.applyWebOrders(shift, [{
  id: 'web-1', order_number: 'W-1', status: 'completed', subtotal: 250, vat_amount: 0, total: 250,
  created_at: new Date().toISOString(), notes: 'Collect at 1pm',
  order_items: [{ id: 'wi-1', product_id: 'p-chk', product_name: 'Chicken Piece', unit_price: 250, quantity: 1, subtotal: 250, notes: 'No salt' }],
  payments: [{ id: 'wp-1', method: 'cash', amount: 250, status: 'completed', created_at: new Date().toISOString() }],
}]);
ok('a web sale downloaded to the till keeps its order and line notes',
  db.prepare(`SELECT notes FROM orders WHERE id='web-1'`).get()?.notes === 'Collect at 1pm'
  && db.prepare(`SELECT notes FROM order_items WHERE id='wi-1'`).get()?.notes === 'No salt');

// ── The screen and the paper (source pins; React and the printer are not run here) ──
const pos = read('src/renderer/pages/POSPage.tsx');
ok('a tap never joins a line that carries a note ("2 spicy" + a tap is a new line)',
  /prev\.find\(i => i\.product\.id === product\.id && i\.selectedVariants\.length === 0 && !i\.notes\)/.test(pos));
// 0.6.28: a note goes only on a line the kitchen has not seen — a changed note used to un-send the WHOLE line and the
// kitchen cooked it again. A sent line's note button is gone, and setLineNote refuses it.
ok('a note changes only a line not yet sent (a sent line is refused — it would be cooked twice)',
  /if \(item && sentQtyOf\(item\) > 0\) \{\s*setKitchenMsg\(/.test(pos)
  && /\{ \.\.\.it, notes: note \}/.test(pos) && /!item\.isFuel && sentQtyOf\(item\) === 0 &&/.test(pos));
ok('the sale sends each line\'s note and the order\'s note',
  (pos.match(/notes: item\.notes \?\? null/g) ?? []).length === 2 && (pos.match(/notes: orderNote\.trim\(\) \|\| null/g) ?? []).length === 2);
ok('a held order keeps its note, and a recall brings it back',
  /orderNote: orderNote\.trim\(\) \|\| undefined/.test(pos) && (pos.match(/setOrderNote\(held\.orderNote \?\? ''\)/g) ?? []).length === 2);
ok('the note editor is on every line (not a fuel line) and on the order',
  /data-testid="line-note-btn"/.test(pos) && /data-testid="order-note-btn"/.test(pos) && /<NoteModal/.test(pos));
const ipc = read('src/main/ipcHandlers.ts');
ok('a held tab stores the order note', /INSERT INTO held_orders \(id, order_number, label, order_type, table_number, delivery_person, cart, held_at, order_note(, delivery_fee(, delivery_free)?)?\)/.test(ipc)
  && /orderNote: r\.order_note \?\? undefined/.test(ipc));
ok('the receipt and kitchen ticket get the order note', /note:\s+payload\.notes \?\? null/.test(ipc));
const bridge = read('src/main/escposBridge.ts');
ok('the print bridge reads the line note the payload carries (notes), and the older name',
  /note:\s+cleanNote\(l\.notes \?\? l\.note\) \?\? undefined/.test(bridge) && /note:\s+cleanNote\(sale\.note, ORDER_NOTE_MAX\) \?\? undefined/.test(bridge));
const ingest = read('src/main/nodeIngest.ts');
ok('the branch LAN carries the notes (an older node ignores them)',
  /'customer_phone', 'created_at', 'device_id', 'pump_id', 'seq',\s*'notes',/.test(ingest) && /'course', 'fire_status',\s*'notes',/.test(ingest));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
