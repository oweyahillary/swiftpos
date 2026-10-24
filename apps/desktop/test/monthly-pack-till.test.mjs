// A466 — the web's Monthly pack (A455) on the till: Manager › Sales › Monthly pack.
// Owner, 2026-10-13: "desktop app does not have some reports I added yesterday, can you add them".
//
// RUNS the real compiled dist/main (the IPC handlers and manageFetch; real SQLite, electron shimmed — the save dialog
// stubbed) against a stand-in cloud, and the real renderer navigation (src/renderer/lib/managerNav.ts, type-stripped).
// The cloud side (a till's PIN sign-in may read and record; the till's own token may not) is in tests/monthly-pack.test.mjs.
//
//   cd apps/desktop && npm run build:main && node test/monthly-pack-till.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - monthlyAnswer not turning "no connection" into the pack's own words → "offline: a plain message" fails
//   - monthly:addMovement not sending this till's branch                     → "Record for the books: POST" fails
//   - the export writing the JSON error / nothing                            → "the Excel is saved where the manager picked" fails
//   - the record form shown without canRecord                                 → "only for expenses.manage" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.MPT_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, MPT_TS: '1' } });
  process.exit(r.status ?? 1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a466-'));
const saveTo = path.join(userData, 'saved-pack');   // no extension: the handler adds .xlsx
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  global.__save = { calls: [], answer: { canceled: false, filePath: ${JSON.stringify(saveTo)} } };
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.12', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return [{}]; } static getFocusedWindow() { return null; } },
    dialog: { showSaveDialog: async (_w, opts) => { global.__save.calls.push(opts); return global.__save.answer; } },
    shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const BR = '22222222-2222-4222-8222-222222222222';
const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0xff, 0x00, 0x7f]);   // a zip's first bytes, and binary ones
const PACK = { title: 'Monthly pack — Westlands — October 2026', methods: ['cash', 'mpesa'],
  summary: { rows: [{ day: '2026-10-01', byMethod: { cash: 500, mpesa: 700 }, total: 1200, expected: 1200, counted: 1150, variance: -50, cashiers: ['Amy'], remarks: [] }],
    byMethod: { cash: 500, mpesa: 700 }, total: 1200, expected: 1200, counted: 1150, variance: -50 },
  expenses: { days: [], byType: [], byMethod: [], total: 0 }, books: [] };

// ── The stand-in cloud ──
const cloud = { up: false, calls: [], status: 200 };
globalThis.fetch = async (url, init = {}) => {
  if (!cloud.up) throw new TypeError('fetch failed');
  const u = String(url), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : null;
  cloud.calls.push({ url: u, method, body, auth: init.headers?.Authorization });
  const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (cloud.status !== 200) return json(cloud.status, { error: 'That branch is not yours.' });
  if (u.includes('/api/reports/monthly/export?')) return new Response(XLSX, { status: 200, headers: {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="zaptill-monthly-westlands-2026-10.xlsx"' } });
  if (u.includes('/api/reports/monthly/movements?')) return json(200, [{ id: 'm1', movement_date: '2026-10-02', method: 'cash', kind: 'bank_deposit', amount: 3000, note: null, recorded_by_name: 'Mary' }]);
  if (u.endsWith('/api/reports/monthly/movements') && method === 'POST') return json(201, { id: 'm2', ...body, recorded_by_name: 'Mary' });
  if (u.includes('/api/reports/monthly/movements/') && method === 'DELETE') return json(200, { ok: true });
  if (u.includes('/api/reports/monthly?')) return json(200, PACK);
  return json(200, []);
};

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'dev-T1', 'biz-1', 'Pizza House', '2026-10-13T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, 'u-mary', 'Mary', 'manager', '{"reports.financial":true,"expenses.manage":true}', ?, 'mgr-tok', '2026-10-13T06:00:00Z')`).run(BR);
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const last = () => cloud.calls.at(-1);

console.log('\nOnline only (A466)\n');
{
  const r = await H['monthly:get'](null, { month: '2026-10' });
  ok('offline: a plain message — the pack is built on the cloud', r.ok === false && r.code === 'offline'
    && r.error === 'The monthly pack needs a connection — it is built from every POS\'s records on the cloud.', JSON.stringify(r));
  const m = await H['monthly:movements'](null, { month: '2026-10' });
  ok('…the books\' entries too', m.ok === false && m.code === 'offline');
}

console.log('\nThe pack, from the cloud\n');
cloud.up = true;
{
  const r = await H['monthly:get'](null, { month: '2026-10' });
  ok('this till\'s branch and the month, with the manager\'s own sign-in', r.ok && r.branch_id === BR && r.data.summary.total === 1200
    && last().url === `http://cloud/api/reports/monthly?month=2026-10&branch_id=${BR}` && last().auth === 'Bearer mgr-tok', JSON.stringify(last()));
  const n = cloud.calls.length;
  const bad = await H['monthly:get'](null, { month: '2026-13' });
  ok('a month that is not one is refused before the cloud is asked', bad.ok === false && /month/i.test(bad.error) && cloud.calls.length === n);
  cloud.status = 403;
  const no = await H['monthly:get'](null, { month: '2026-10' });
  ok('a role without financial reports is told so (not "this change")', no.ok === false && no.status === 403 && /monthly pack/.test(no.error), JSON.stringify(no));
  cloud.status = 200;
}

console.log('\nDownload Excel\n');
{
  const r = await H['monthly:export'](null, { month: '2026-10' });
  const saved = `${saveTo}.xlsx`;
  ok('the Excel is saved where the manager picked — the cloud\'s bytes, unchanged', r.ok && r.path === saved && fs.existsSync(saved)
    && Buffer.compare(fs.readFileSync(saved), XLSX) === 0, JSON.stringify(r));
  ok('…offered under the name the web uses', global.__save.calls.at(-1)?.defaultPath === 'zaptill-monthly-westlands-2026-10.xlsx'
    && last().url === `http://cloud/api/reports/monthly/export?month=2026-10&branch_id=${BR}`, JSON.stringify(global.__save.calls.at(-1)));
  global.__save.answer = { canceled: true };
  const c = await H['monthly:export'](null, { month: '2026-10' });
  ok('cancelling the dialog is not an error', c.ok === false && c.canceled === true && !c.error, JSON.stringify(c));
  global.__save.answer = { canceled: false, filePath: saveTo };
  cloud.up = false;
  const off = await H['monthly:export'](null, { month: '2026-10' });
  ok('offline: no dialog, the plain message', off.ok === false && off.code === 'offline' && global.__save.calls.length === 2);
  cloud.up = true;
}

console.log('\nRecord for the books\n');
{
  const l = await H['monthly:movements'](null, { month: '2026-10' });
  ok('the month\'s entries for this branch', l.ok && l.data[0].id === 'm1' && last().url === `http://cloud/api/reports/monthly/movements?month=2026-10&branch_id=${BR}`);
  const a = await H['monthly:addMovement'](null, { movement_date: '2026-10-05', method: 'mpesa', kind: 'other_income', amount: 1500, note: '  used oil sold ' });
  ok('Record for the books: POST with this till\'s branch, the entry as typed', a.ok && last().method === 'POST' && last().url === 'http://cloud/api/reports/monthly/movements'
    && last().body.branch_id === BR && last().body.kind === 'other_income' && last().body.amount === 1500 && last().body.note === 'used oil sold'
    && last().auth === 'Bearer mgr-tok', JSON.stringify(last()));
  const d = await H['monthly:removeMovement'](null, { id: 'm1' });
  ok('Remove: DELETE that entry', d.ok && last().method === 'DELETE' && last().url === 'http://cloud/api/reports/monthly/movements/m1', JSON.stringify(last()));
  cloud.status = 403;
  const no = await H['monthly:addMovement'](null, { movement_date: '2026-10-05', method: 'cash', kind: 'charges', amount: 10 });
  ok('refused by the cloud: the screen is told why', no.ok === false && /record for the books/.test(no.error), JSON.stringify(no));
  cloud.status = 200;
  let threw = null;
  try { await H['monthly:addMovement'](null, { movement_date: '2026-10-05', method: 'cash', kind: 'charges', amount: '10' }); } catch (e) { threw = e; }
  ok('the payload is checked at the boundary (an amount is a number)', !!threw);
}

console.log('\nThe screen (source)\n');
{
  const Nav = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'managerNav.ts')).href);
  // A490: each page by its own fine key (NavAccess).
  const base = { isRestaurant: false, canOverview: true, canOrders: true, canItems: true, canShifts: true, canExpenses: true, canCloseDay: true,
    canMenu: true, canOffers: true, canSettings: true, canPrinting: true, canStaff: true, showStock: false };
  const sales = (a) => Nav.groupOf(Nav.buildManagerNav({ ...base, ...a }), 'orders').tabs.map((t) => t.key);
  ok('Sales › Monthly pack with reports.monthly_pack (or expenses.manage) — with or without the online licence', sales({ canMonthly: true, online: false }).includes('monthly') && !sales({ canMonthly: false, online: true }).includes('monthly'));
  const mp = read('src/renderer/pages/ManagerPage.tsx');
  // A490: reports.financial is a broad key — the fine key is reports.monthly_pack (A481: or expenses.manage).
  ok('ManagerPage: the tab for reports.monthly_pack or expenses.manage, recording for expenses.manage', /canMonthly: has\('reports\.monthly_pack'\) \|\| has\('expenses\.manage'\),/.test(mp)
    && /case 'monthly': return <MonthlyPackTab currency=\{currency\} canRecord=\{has\('expenses\.manage'\)\} \/>;/.test(mp));
  const tab = read('src/renderer/components/MonthlyPackTab.tsx');
  ok('the record form and Remove only for expenses.manage', /\{canRecord && \(\s*<div className="flex flex-wrap gap-2 items-end" data-testid="pack-record-form">/.test(tab)
    && /\{canRecord && \(confirming === m\.id/.test(tab));
  ok('the three views and Download Excel, as on the web', /'Daily sales'/.test(tab) && /`Expenses \(\$\{money\(pack\.expenses\.total\)\}\)`/.test(tab)
    && /'Cash & M-Pesa books'/.test(tab) && /posApi\.monthly\.export\(month\)/.test(tab) && /data-testid="pack-download"/.test(tab));
  ok('the month on the till\'s own clock (the 1st at 01:00 is the new month)', /`\$\{now\.getFullYear\(\)\}-\$\{String\(now\.getMonth\(\) \+ 1\)\.padStart\(2, '0'\)\}`/.test(tab));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
