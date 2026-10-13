// A460 + A459 + A197 — what the online licence shows, staff edits on the till (offline too), and stock transfers.
// Owner, 2026-10-13: images, variants / modifiers / combos, offers setup and stock "can be activated for desktop only if
// the client has paid for the online licence, if not they should never be visible on the desktop app"; staff on a till
// offline — rename, role and deactivate, "yes, all three"; "A197 … tied to the online licence just like stock … inside
// the stock tab".
//
// RUNS the real compiled dist/main (the IPC handlers, localChanges, branchStaff; real SQLite, electron shimmed) with a
// stand-in cloud, and the real renderer navigation (src/renderer/lib/managerNav.ts, type-stripped).
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/licence-staff-transfers.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - managerNav showing Offers without the licence             → "Offers only with the online licence" fails
//   - requireOnlineLicence not called by manage:saveOffer         → "an offer cannot be saved without the licence" fails
//   - manage:updateStaff back to the cloud first                  → "a rename works on this till at once, offline" fails
//   - branchStaff not filtering inactive staff                    → "a deactivated person cannot sign in here" fails
//   - transfers:status losing the cloud's code                    → "same person: the screen is told why" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.LST_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, LST_TS: '1' } });
  process.exit(r.status ?? 1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a460-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.11', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const BR = '22222222-2222-4222-8222-222222222222', AMY = '44444444-4444-4444-8444-444444444444';
const R_CASH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', R_SUP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ── The stand-in cloud ──
const cloud = { up: false, patches: [] };
globalThis.fetch = async (url, init = {}) => {
  if (!cloud.up) throw new TypeError('fetch failed');
  const u = String(url), body = init.body ? JSON.parse(init.body) : {};
  const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('/api/stock/transfers?')) return json(200, [{ id: 't1', transfer_number: 'TRF-0001', status: 'in_transit', from_branch_id: 'br-other', to_branch_id: BR,
    from_branch_name: 'Kilimani', to_branch_name: 'Westlands', notes: null, created_at: '2026-10-13T08:00:00Z',
    stock_transfer_items: [{ id: 'i1', product_id: 'p1', quantity: 10, quantity_received: null, products: { name: 'Soda' } }] }]);
  if (u.includes('/api/stock/transfers/t1/status')) {
    cloud.patches.push(body);
    if (body.status === 'received' && !body.allow_same_user) return json(409, { error: 'You despatched this transfer — confirm to receive it yourself.', code: 'same_user_receipt' });
    return json(200, { id: 't1', status: body.status });
  }
  if (u.endsWith('/api/branches')) return json(200, [{ id: BR, name: 'Westlands' }, { id: 'br-other', name: 'Kilimani' }]);
  return json(200, []);
};

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-T1', 'biz-1', 'Pizza House', '2026-10-13T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-mary', 'Mary', 'manager', '{"staff.manage":true,"products.manage":true,"inventory.transfer":true}', ?, 'mgr-tok', '2026-10-13T06:00:00Z')`).run(BR);
db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('roles_cache', ?, ?)`)
  .run(JSON.stringify([{ id: R_CASH, name: 'cashier', permissions: [{ key: 'orders.create' }] }, { id: R_SUP, name: 'supervisor', permissions: [{ key: 'orders.void' }] }]), new Date().toISOString());
const bcrypt = require('bcryptjs');
db.prepare(`INSERT INTO branch_staff (staff_id, name, role_name, branch_id, permissions, pin_hash_enc, status) VALUES (?, 'Amy', 'cashier', ?, '{}', ?, 'active')`)
  .run(AMY, BR, Buffer.from('w:' + bcrypt.hashSync('2580', 4)).toString('base64'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const Nav = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'managerNav.ts')).href);
const tabsOf = (a) => Nav.buildManagerNav({ isRestaurant: true, isManagerRole: true, canManageProducts: true, canManageStaff: true,
  canManageSettings: true, canPrinting: true, showStock: false, canWaste: true, canTransfer: true, ...a }).flatMap((g) => g.tabs.map((t) => t.key));

console.log('\nThe online licence (A460)\n');
{
  const without = tabsOf({ online: false }), withIt = tabsOf({ online: true });
  ok('Offers only with the online licence — never shown without it', !without.includes('offers') && withIt.includes('offers'), JSON.stringify(without));
  ok('…Wastage and Transfers likewise (stock is premium)', !without.includes('wastage') && !without.includes('transfers') && withIt.includes('wastage') && withIt.includes('transfers'));
  ok('…while the basics stay for everyone (Menu, Staff, Printing, Close)', ['menu', 'staff', 'printers', 'dayclose'].every((k) => without.includes(k)));
  let refused = null;
  try { await H['manage:saveOffer'](null, { name: 'Drinks 20%', kind: 'percent_off', value: 20 }); } catch (e) { refused = e; }
  ok('an offer cannot be saved without the licence (the screen is hidden; the till refuses too)', /online licence/.test(String(refused?.message)), String(refused?.message));
  let combo = null;
  try { await H['manage:createCombo'](null, { name: 'Meal' }); } catch (e) { combo = e; }
  let variant = null;
  try { await H['manage:createVariantGroup'](null, { product_id: 'p1', name: 'Size' }); } catch (e) { variant = e; }
  ok('…nor a combo or a variant group', /online licence/.test(String(combo?.message)) && /online licence/.test(String(variant?.message)));
  const mw = read('src/renderer/pages/MenuWorkbench.tsx');
  ok('the item screen shows combos, choices and extras only with the licence', /\{online && <div className="border-t border-gray-800 pt-3 space-y-3" data-testid="premium-choices">/.test(mw));
  ok('a menu file\'s variant and add-on columns are used only with the licence', /specs:\s+online \? readVariantSpecs\(r\) : \[\]/.test(read('src/renderer/pages/ManageTabs.tsx')));
}

console.log('\nStaff on the till, offline (A459)\n');
const verify = async (pin) => { try { return await H['auth:verifyPin'](null, { pin, branch_id: BR }); } catch (e) { return { error: e.message }; } };
{
  const r = await H['manage:updateStaff'](null, { id: AMY, patch: { name: 'Amy W' } });
  ok('a rename works on this till at once, offline (and waits for the cloud)', r.change_state === 'pending'
    && db.prepare(`SELECT name FROM branch_staff WHERE staff_id = ?`).get(AMY).name === 'Amy W'
    && db.prepare(`SELECT state FROM local_changes WHERE entity = 'staff' AND entity_id = ? ORDER BY made_at DESC`).get(AMY)?.state === 'pending', JSON.stringify(r));
  await H['manage:updateStaff'](null, { id: AMY, patch: { role_id: R_SUP } });
  const row = db.prepare(`SELECT role_name, permissions FROM branch_staff WHERE staff_id = ?`).get(AMY);
  ok('a new role: its name and permissions on this till at once', row.role_name === 'supervisor' && JSON.parse(row.permissions)['orders.void'] === true, JSON.stringify(row));
  ok('Amy signs in with her PIN', (await verify('2580'))?.staff?.name === 'Amy W', JSON.stringify(await verify('2580')));
  db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
    VALUES (1, 'u-mary', 'Mary', 'manager', '{"staff.manage":true,"products.manage":true,"inventory.transfer":true}', ?, 'mgr-tok', '2026-10-13T06:00:00Z')`).run(BR);
  await H['manage:updateStaff'](null, { id: AMY, patch: { is_active: false } });   // what the old screen sent
  ok('Deactivate (even as the old screen sent it) stops the PIN on this till at once', !!(await verify('2580')).error
    && db.prepare(`SELECT status FROM branch_staff WHERE staff_id = ?`).get(AMY).status === 'inactive');
  const ch = db.prepare(`SELECT data FROM local_changes WHERE entity = 'staff' AND entity_id = ? ORDER BY made_at DESC`).get(AMY);
  ok('…and the cloud is sent a status, never { is_active }', JSON.parse(ch.data).status === 'inactive' && !('is_active' in JSON.parse(ch.data)), ch.data);
  db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
    VALUES (1, 'u-mary', 'Mary', 'manager', '{"staff.manage":true,"products.manage":true,"inventory.transfer":true}', ?, 'mgr-tok', '2026-10-13T06:00:00Z')`).run(BR);
  await H['manage:updateStaff'](null, { id: AMY, patch: { status: 'active' } });
  ok('Reactivate brings the PIN back on this till', (await verify('2580'))?.staff?.name === 'Amy W');
  const ui = read('src/renderer/pages/ManageTabs.tsx');
  ok('the staff screen has Edit (name, role) and Deactivate offline too', /data-testid="staff-edit-open"/.test(ui) && /data-testid="staff-toggle-active"/.test(ui)
    && !/\{!offline && \(\s*<button onClick=\{\(\) => toggleActive\(m\)\}/.test(ui));
}

console.log('\nStock transfers (A197)\n');
{
  db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
    VALUES (1, 'u-mary', 'Mary', 'manager', '{"staff.manage":true,"products.manage":true,"inventory.transfer":true}', ?, 'mgr-tok', '2026-10-13T06:00:00Z')`).run(BR);
  let refused = null;
  try { await H['transfers:list'](null); } catch (e) { refused = e; }
  ok('without the licence the till refuses the transfers too', /online licence/.test(String(refused?.message)));
  C.setWebPosEnabled(true);
  cloud.up = true;
  const list = await H['transfers:list'](null);
  ok('with it: this branch\'s transfers, from the cloud', list.ok && list.branch_id === BR && list.data[0].transfer_number === 'TRF-0001', JSON.stringify(list));
  const r = await H['transfers:status'](null, { id: 't1', status: 'received', received_items: [{ product_id: 'p1', quantity_received: 9 }], receipt_note: 'one crate cracked' });
  ok('same person: the screen is told why (the cloud\'s code comes through)', r.ok === false && r.code === 'same_user_receipt', JSON.stringify(r));
  const again = await H['transfers:status'](null, { id: 't1', status: 'received', received_items: [{ product_id: 'p1', quantity_received: 9 }], receipt_note: 'one crate cracked', allow_same_user: true });
  ok('…and it goes through when they say so — with what arrived and the note', again.ok && cloud.patches.at(-1).allow_same_user === true
    && cloud.patches.at(-1).received_items[0].quantity_received === 9 && cloud.patches.at(-1).receipt_note === 'one crate cracked', JSON.stringify(cloud.patches.at(-1)));
  const bad = await H['transfers:status'](null, { id: 't1', status: 'deleted' });
  ok('only the cloud\'s steps (despatch, receive, cancel)', bad.ok === false);
  const created = await H['transfers:create'](null, { to_branch_id: 'br-other', items: [{ product_id: 'p1', quantity: 0 }] });
  ok('a transfer needs an item with a quantity', created.ok === false && /at least one item/.test(created.error));
  const branches = await H['transfers:branches'](null);
  ok('the branches to send to leave this one out', branches.ok && branches.data.length === 1 && branches.data[0].name === 'Kilimani', JSON.stringify(branches));
  ok('the Stock group shows Transfers (with the licence and inventory.transfer)', /case 'transfers': return online \? <TransfersTab \/>/.test(read('src/renderer/pages/ManagerPage.tsx')));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
