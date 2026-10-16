// A501 (2026-10-15) — a till and its branch server heal themselves, and say what is wrong where a technician looks.
//
// Owner: "there exists a problem between a node and a server syncing … fix it once and for all … some tills are
// misbehaving and clients are not happy". Checks, on the REAL compiled dist/main, REAL HTTP(S) servers and a REAL SQLite
// file (electron shimmed):
//   1  a branch mismatch (403), an encryption refusal (426) or an unreadable request (400) never fails a row; the
//      server's identity (certificate, device id, THIS till's branch) changing re-arms what it refused; "Retry failed
//      records" on the Tech page does it on demand (tech / settings.business only)
//   2  a peer row refused in a pull is quarantined, not lost: a new trading day arriving with the event that closes the
//      last one lands in the same pass; a row refused for good is retried with backoff, then given up (kept), and re-armed
//      on a server change; the server's own ingest retries such rows after its event sweep
//   3  a pinned server that answers without TLS is a PROBLEM (never "encrypted") and the till re-checks it by itself;
//      slow gateway calls no longer starve the branch's own LAN calls (separate pools)
//   4  a till follows its OWN server to a new address (beacon fingerprint → certificate byte for byte → device id) —
//      never another server, never on a beacon alone, never unpinned; and with no re-offer
//   5  every channel's health is recorded (last success, last error, failures in a row); the backlog is reported
//   6  the distribution and numbering queries use the (device_id, seq) index (EXPLAIN QUERY PLAN)
//   7  /node/health reports protocol, capabilities, min_till_protocol; an older server or an older till is named
//
//   cd apps/desktop && npm run build:main && node test/sync-self-heal.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main and re-running):
//   - pushRowsToNode treating 403 as 'refused' again                          → "1: a branch mismatch never fails a row" fails
//   - nodeIdentityKey without the branch                                       → "1: changing the branch back re-arms" fails
//   - applyDistribution without quarantinePeerRow                              → "2: the new trading day lands" fails
//   - lanFetch not recording a handshake failure (tlsHandshake)                → "3: a pinned server answering plain is a problem" fails
//   - agentFor ignoring the gateway flag (one pool of 8)                       → "3: a LAN call is not stuck behind 10 slow gateway calls" fails
//   - followMovedServer without the server device id check                     → "4: another certificate claiming the code is never followed" fails
//     (the byte-for-byte certificate compare is backed by the pinned handshake itself, so removing it alone cannot bite)
//   - distributionSql back to COALESCE(device_id,'') = COALESCE(?,'')          → "6: distribution uses the index" fails
//   - refusalReasonFor calling a device-key refusal 'access_code'              → "5: a device-key refusal is NOT called an access-code problem" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a501-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.16', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('E:' + s, 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8').slice(2) },
    net: { isOnline: () => true },
    session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
const realFetch = globalThis.fetch;
// The cloud is never reached; the test's servers (127.0.0.1) are.
globalThis.fetch = async (url, init) => (String(url).startsWith('http://127.0.0.1') ? realFetch(url, init) : Promise.reject(new TypeError('fetch failed')));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const throws = async (f) => { try { await f(); return null; } catch (e) { return e; } };

process.env.SWIFTPOS_NODE_PORT = String(42000 + Math.floor(Math.random() * 15000));
const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u', 'biz-1', 'Shop', '2026-10-15T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
const I = require(path.join(dist, 'nodeIngest.js'));
const NC = require(path.join(dist, 'nodeClient.js'));
const NH = require(path.join(dist, 'nodeHealth.js'));
const NF = require(path.join(dist, 'nodeFollow.js'));
const NS = require(path.join(dist, 'nodeServer.js'));
const T = require(path.join(dist, 'lanTls.js'));
const G = require(path.join(dist, 'cloudGateway.js'));
const B = require(path.join(dist, 'serverBeacon.js'));
const SE = require(path.join(dist, 'syncEngine.js'));
const TS = require(path.join(dist, 'techService.js'));
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); });
const send = (res, status, obj, extra = {}) => { const p = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p), ...extra }); res.end(p); };

// ── A fake branch server: plain HTTP, its answers set per test ────────────────────────────────────────────────────────
const fake = { syncStatus: 200, syncError: null, health: { device_id: 'srv-1', branch_id: 'br-1' }, seen: [] };
const fakeSrv = http.createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];
  fake.seen.push(url);
  if (url === '/node/health') return send(res, 200, { ok: true, role: 'node', ...fake.health });
  if (url === '/node/time') return send(res, 200, { now: new Date().toISOString(), tz_offset: new Date().getTimezoneOffset() });
  if (url === '/node/cursors') return send(res, 200, { cursors: [] });
  if (url === '/node/sync') {
    const b = await body(req);
    if (fake.syncStatus !== 200) return send(res, fake.syncStatus, { error: fake.syncError ?? 'no' });
    const results = {};
    for (const [t, rows] of Object.entries(b.tables ?? {})) results[t] = { applied: rows.length, duplicate: 0, cursor: 0, rejected: [], applied_ids: rows.map((r) => r.id) };
    return send(res, 200, { ok: true, results });
  }
  if (url === '/node/since') return send(res, fake.sinceStatus ?? 200, fake.sinceStatus ? { error: fake.sinceError } : { batches: [], has_more: false });
  send(res, 404, { error: 'not found' });
});
const FAKE = `http://127.0.0.1:${await listen(fakeSrv)}`;

C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud.invalid', branch_id: 'br-1', device_id: 'dev-T1',
  device_role: 'till', terminal_code: 'T1', device_name: 'Till 1', node_url: FAKE, node_secret: 'SECRET-1' });

const q = db.prepare(`INSERT INTO node_queue (table_name, row_id, payload, created_at, status, attempts, last_error) VALUES (?, ?, ?, datetime('now'), ?, ?, ?)`);
const qrow = (id) => db.prepare(`SELECT status, attempts, last_error FROM node_queue WHERE row_id = ?`).get(id);
const setTech = (on) => db.prepare(`UPDATE tech_state SET session_json = ? WHERE id = 1`).run(on
  ? JSON.stringify({ techId: 't', techName: 'Tech', branchId: C.getDeviceConfig().branch_id, startedAt: Date.now(), expiresAt: Date.now() + 3_600_000, tokenHash: 'x' }) : null);
TS.getActiveSession();   // makes tech_state

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1 — a refusal of the TILL never fails its rows; a changed identity re-arms them\n');
{
  for (const id of ['r-1', 'r-2', 'r-3']) q.run('orders', id, JSON.stringify({ id, seq: 1, device_id: 'dev-T1' }), 'pending', 0, null);
  fake.syncStatus = 403; fake.syncError = 'branch mismatch';
  let last;
  for (let i = 0; i < 7; i++) last = await SE.replicateToNode();
  ok('1: a branch mismatch never fails a row — seven passes later every row is pending, no attempt counted',
    ['r-1', 'r-2', 'r-3'].every((id) => { const r = qrow(id); return r.status === 'pending' && r.attempts === 0 && /^transport: /.test(r.last_error ?? ''); }),
    JSON.stringify(qrow('r-1')));
  ok('…and the pass says so in words (another branch), not "refused"', last.errors.some((e) => /another branch/.test(e)), JSON.stringify(last.errors));
  ok('…the manager\'s notice is told it is the BRANCH, not the access code', G.nodeRefusal()?.reason === 'branch', JSON.stringify(G.nodeRefusal()));
  ok('…the sync channel records it (HTTP 403, the server\'s words, failures in a row)',
    NH.channelState('sync').lastStatus === 403 && NH.channelState('sync').failures >= 7 && /branch mismatch/.test(NH.channelState('sync').lastError), JSON.stringify(NH.channelState('sync')));
  for (const st of [426, 400]) {
    fake.syncStatus = st; fake.syncError = st === 426 ? 'This branch server accepts only encrypted connections' : 'bad request';
    await SE.replicateToNode();
  }
  ok('1: a 426 (encryption) or a 400 (unreadable request) never counts either', qrow('r-1').attempts === 0 && qrow('r-1').status === 'pending', JSON.stringify(qrow('r-1')));
  ok('…a 426 is named as the encryption refusal', G.nodeRefusal()?.reason === 'tls', JSON.stringify(G.nodeRefusal()));

  // The identity: certificate (none here), server device id, this till's branch.
  db.prepare(`UPDATE node_queue SET status = 'failed', attempts = 5 WHERE row_id IN ('r-1','r-2','r-3')`).run();
  db.prepare(`DELETE FROM maintenance_state WHERE key = 'node_identity'`).run();   // as on a till upgrading to this build
  await SE.checkNodeIdentity(true);
  ok('1: the first identity this build records re-arms what failed before it', qrow('r-1').status === 'pending' && qrow('r-1').attempts === 0, JSON.stringify(qrow('r-1')));
  const fails = () => db.prepare(`UPDATE node_queue SET status = 'failed', attempts = 5 WHERE row_id IN ('r-1','r-2','r-3')`).run();
  fails(); await SE.checkNodeIdentity(true);
  ok('…the same identity re-arms nothing', qrow('r-1').status === 'failed');
  C.saveDeviceConfig({ branch_id: 'br-2' }); await SE.checkNodeIdentity(true);
  ok('1: a cloud sign-in rebinding the till to another branch re-arms (a changed identity)', qrow('r-1').status === 'pending');
  setTech(true);
  const mm = await H['node:syncHealth'](null, undefined);
  ok('…and the branch mismatch is shown on the Tech page (the server serves br-1)', mm.branch?.mismatch === true && mm.branch.server === 'br-1', JSON.stringify(mm.branch));
  setTech(false);
  fails(); C.saveDeviceConfig({ branch_id: 'br-1' }); await SE.checkNodeIdentity(true);
  ok('1: changing the branch back re-arms the outbox', qrow('r-1').status === 'pending' && qrow('r-2').status === 'pending', JSON.stringify(qrow('r-1')));
  fails(); fake.health = { device_id: 'srv-2', branch_id: 'br-1' }; await SE.checkNodeIdentity(true);
  ok('1: a different server device (reinstalled) re-arms', qrow('r-3').status === 'pending');
  fake.health = { device_id: 'srv-1', branch_id: 'br-1' }; await SE.checkNodeIdentity(true);

  fake.syncStatus = 200;
  await SE.replicateToNode();
  ok('…once the server takes them, they are delivered', ['r-1', 'r-2', 'r-3'].every((id) => qrow(id).status === 'delivered'), JSON.stringify(qrow('r-1')));
  ok('…and the refusal clears (a keyed route accepted this till)', G.nodeRefusal() === null, JSON.stringify(G.nodeRefusal()));
  ok('…the sync channel is healthy again', NH.channelState('sync').failures === 0 && !!NH.channelState('sync').lastOkAt);

  // "Retry failed records" on the Tech page.
  fails();
  setTech(false);
  const refused = await throws(() => H['node:retryFailed'](null, undefined));
  ok('1: Retry failed records — refused without a technician or the settings permission', /technician/.test(refused?.message ?? ''), String(refused));
  ok('…nothing re-armed by the refusal', qrow('r-1').status === 'failed');
  setTech(true);
  const r = await H['node:retryFailed'](null, undefined);
  ok('1: Retry failed records — a technician re-arms every failed record', r.requeued === 3 && qrow('r-1').status === 'pending', JSON.stringify(r));
  const health = await H['node:syncHealth'](null, undefined);
  ok('5: the Tech page reads every channel, the backlog and the server', health.role === 'till' && health.channels.length === 8
    && health.channels.map((c) => c.channel).join(',') === 'health,sync,since,poll,roster,reference,gateway,tls'
    && typeof health.backlog.pending === 'number' && health.server?.device_id === 'srv-1' && health.branch.mismatch === false, JSON.stringify(health).slice(0, 400));
  await SE.replicateToNode();

  const src = { pre: read('src/main/preload.ts'), api: read('src/renderer/lib/posApi.ts'), sch: read('src/main/ipcSchemas.ts'), tech: read('src/renderer/pages/TechPage.tsx'),
    panel: read('src/renderer/components/BranchSyncPanel.tsx') };
  ok('1: the channel is bridged, typed and registered (node:retryFailed, node:syncHealth)',
    /'node:retryFailed'/.test(src.pre) && /'node:syncHealth'/.test(src.pre) && /retryFailed: \(\) => Promise/.test(src.api) && /'node:retryFailed':\s+NO_PAYLOAD/.test(src.sch));
  ok('5: the Tech page shows the panel (a till with a server only) and its button', /<BranchSyncPanel \/>/.test(src.tech) && /Retry failed records/.test(src.panel)
    && /dev\.device_role === 'till' && <BranchSyncPanel/.test(src.tech));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2 — a refused peer row is quarantined and tried again, never lost\n');
{
  const day = (id, date, seq, extra = {}) => ({ id, business_id: 'biz-1', branch_id: 'br-1', device_id: 'dev-T2', terminal_code: 'T2', business_date: date,
    opened_at: `${date}T06:00:00.000Z`, status: 'open', created_at: `${date}T06:00:00.000Z`, seq, ...extra });
  I.applyDistribution([{ device_id: 'dev-T2', table: 'business_days', rows: [day('d-1', '2026-10-14', 1)] }]);
  ok('(yesterday\'s day from another till is held, open)', db.prepare(`SELECT status FROM business_days WHERE id='d-1'`).get()?.status === 'open');
  const ev = { id: 'ev-close-1', business_id: 'biz-1', branch_id: 'br-1', device_id: 'dev-T2', seq: 1, kind: 'day_closed', target_table: 'business_days',
    target_id: 'd-1', payload: JSON.stringify({ status: 'closed', closed_at: '2026-10-14T22:00:00.000Z' }), created_at: '2026-10-14T22:00:00.000Z' };
  const d = I.applyDistribution([
    { device_id: 'dev-T2', table: 'business_days', rows: [day('d-2', '2026-10-15', 2)] },
    { device_id: 'dev-T2', table: 'events', rows: [ev] },
  ]);
  ok('2: the new trading day lands in the same pass as the event closing the last one',
    db.prepare(`SELECT status FROM business_days WHERE id='d-2'`).get()?.status === 'open'
    && db.prepare(`SELECT status FROM business_days WHERE id='d-1'`).get()?.status === 'closed', JSON.stringify(d));
  ok('…and leaves nothing in the quarantine', I.peerQuarantineSummary().waiting === 0 && I.peerQuarantineSummary().givenUp === 0, JSON.stringify(I.peerQuarantineSummary()));
  ok('…and its refusal note is gone', !db.prepare(`SELECT 1 FROM maintenance_state WHERE key = 'distribution_refused:dev-T2:business_days:d-2'`).get());

  // A row refused for good (another branch): it does not block the rest, waits with backoff, then is given up — kept.
  const order = (id, seq, extra = {}) => ({ id, business_id: 'biz-1', branch_id: 'br-1', order_number: `T2-${id}`, status: 'completed',
    subtotal: 100, vat_amount: 0, total: 100, created_at: '2026-10-15T08:00:00.000Z', device_id: 'dev-T2', seq, ...extra });
  const r = I.applyDistribution([{ device_id: 'dev-T2', table: 'orders', rows: [order('o-1', 1), order('o-bad', 2, { branch_id: 'br-OTHER' }), order('o-3', 3)] }]);
  ok('2: a refused row never blocks the others (applied, cursor past it)', r.applied === 2 && I.getCursor('dev-T2', 'orders') === 3, JSON.stringify(r));
  const qr = () => db.prepare(`SELECT attempts, status, next_at, reason FROM peer_quarantine WHERE row_id = 'o-bad'`).get();
  ok('2: …it is quarantined with its reason (no longer skipped for good)', qr()?.status === 'waiting' && /different branch/.test(qr()?.reason ?? ''), JSON.stringify(qr()));
  const t0 = Date.now();
  I.retryPeerQuarantine({ now: t0 });
  const a1 = qr().attempts;
  I.retryPeerQuarantine({ now: t0 + 1000 });
  ok('2: backoff — not tried again before it is due', qr().attempts === a1, JSON.stringify(qr()));
  let t = t0;
  for (let i = 0; i < 20; i++) { t += 3_700_000; I.retryPeerQuarantine({ now: t }); }
  ok('2: bounded — given up after the last attempt, and KEPT (shown on the Tech page)', qr().status === 'given_up' && qr().attempts === I.QUARANTINE_MAX_ATTEMPTS, JSON.stringify(qr()));
  ok('…the backoff doubles and is capped at an hour', I.quarantineBackoffMs(1) === 30_000 && I.quarantineBackoffMs(2) === 60_000 && I.quarantineBackoffMs(30) === 3_600_000);
  ok('…the summary counts it', I.peerQuarantineSummary().givenUp === 1);
  // A server change re-arms it; once it can be applied (the till's branch is now the row's), it lands.
  C.saveDeviceConfig({ branch_id: 'br-OTHER' });
  const id = I.noteNodeIdentity(I.nodeIdentityKey({ certCode: null, serverDevice: 'srv-1', branch: 'br-OTHER' }));
  ok('2: a server change (identity) re-arms the quarantine', id.released >= 1 && qr().status === 'waiting' && qr().attempts === 0, JSON.stringify(id));
  I.retryPeerQuarantine();
  ok('…and the row lands when it can', !!db.prepare(`SELECT 1 FROM orders WHERE id = 'o-bad'`).get() && !qr());
  C.saveDeviceConfig({ branch_id: 'br-1' });

  // The server's ingest: rows refused only for their order in one batch are retried after its event sweep.
  const day3 = (id, date, seq) => ({ ...day(id, date, seq), device_id: 'dev-T3', terminal_code: 'T3' });
  I.applyPeerRows('business_days', 'dev-T3', [day3('e-1', '2026-10-14', 1)]);
  const res = I.applyPeerRows('business_days', 'dev-T3', [day3('e-2', '2026-10-15', 2)]);
  ok('(the server refuses the new day while the last is open)', res.rejected.length === 1, JSON.stringify(res));
  I.applyPeerRows('events', 'dev-T3', [{ ...ev, id: 'ev-close-3', device_id: 'dev-T3', target_id: 'e-1' }]);
  I.applyPendingEvents();
  const fixed = I.retryRefusedAfterEvents('business_days', 'dev-T3', [day3('e-2', '2026-10-15', 2)], res);
  ok('2: the server takes it after the event sweep and the answer says so (held, not refused)',
    fixed.rejected.length === 0 && fixed.applied_ids.includes('e-2'), JSON.stringify(fixed));
  ok('…/node/sync runs that retry after applyPendingEvents', /applyPendingEvents\(\);\s*\/\/ A501[\s\S]{0,600}retryRefusedAfterEvents\(table, peerDeviceId, rows, results\[table\]/.test(read('src/main/nodeServer.ts')));
  ok('…and the till\'s 30 s pull retries the quarantine whether or not anything new came', /retryPeerQuarantine\(\);/.test(read('src/main/index.ts')));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3 — TLS: a pinned server answering without TLS is a problem; the pools are separate\n');
// A TLS / plain server on one port (as nodeServer), its mode switched by the test.
function dualServer(id, handler) {
  const st = { mode: 'tls' };
  const plain = http.createServer(handler(st));
  const tls = https.createServer({ cert: id.cert, key: id.key }, handler(st));
  tls.on('tlsClientError', () => {});
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('data', (first) => {
      sock.pause(); sock.unshift(first);
      (st.mode === 'tls' && first[0] === 0x16 ? tls : plain).emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
  });
  return { st, srv, close: () => { srv.close(); plain.closeAllConnections?.(); tls.closeAllConnections?.(); } };
}
const idA = T.makeServerIdentity('A501 server A');
const idB = T.makeServerIdentity('A501 server B');
const serverHandler = (cert, device) => (st) => async (req, res) => {
  const url = (req.url ?? '').split('?')[0];
  if (url === '/node/tls') return st.mode === 'tls' ? send(res, 200, { cert, code: T.securityCode(cert) }) : send(res, 404, { error: 'not found' });
  if (url === '/node/health') return send(res, 200, { ok: true, role: 'node', device_id: device, branch_id: 'br-1', protocol: 2, min_till_protocol: 1, capabilities: ['tls'] });
  if (url.startsWith('/node/cloud/')) { await sleep(st.gatewayDelay ?? 0); return send(res, 200, { ok: true }, { 'x-node-gateway': '1' }); }
  send(res, 404, { error: 'not found' });
};
const A = dualServer(idA, serverHandler(idA.cert, 'srv-1'));
const PA = await listen(A.srv);
const URL_A = `http://127.0.0.1:${PA}`;
{
  C.saveDeviceConfig({ node_url: URL_A });
  T.setTillPin(idA.cert, { confirmed: true });
  A.st.mode = 'plain';
  const h = await NC.checkNodeHealth();
  ok('3: a pinned server answering plain HTTP: nothing is sent unencrypted (the request fails)', h.ok === false, JSON.stringify(h));
  ok('3: a pinned server answering plain is a problem on the Tech page — never "encrypted"', T.nodeTlsStatus().state === 'tls_failed', JSON.stringify(T.nodeTlsStatus()));
  ok('…the TLS channel records it', NH.channelState('tls').failures > 0 && /encrypted/.test(NH.channelState('tls').lastError ?? ''), JSON.stringify(NH.channelState('tls')));
  ok('3: the till re-checks /node/tls by itself (the 60 s tick): still plain, still a problem — and the pin stands',
    await T.ensureNodeTls(() => NC.nodeHeaders()) === 'tls_failed' && T.tillPin() !== null);
  A.st.mode = 'tls';
  ok('3: once the server answers encrypted with the pinned certificate, the tick clears it by itself',
    await T.ensureNodeTls(() => NC.nodeHeaders()) === 'encrypted' && T.nodeTlsStatus().state === 'encrypted', JSON.stringify(T.nodeTlsStatus()));
  ok('…and the TLS channel is healthy', NH.channelState('tls').failures === 0);

  // Pools: ten slow gateway calls must not hold the branch's own calls.
  A.st.gatewayDelay = 2500;
  const slow = Array.from({ length: 10 }, () => T.lanFetch(`${URL_A}/node/cloud/api/slow`, { headers: NC.nodeHeaders() }).then((r) => r.status).catch((e) => String(e)));
  await sleep(150);
  const t0 = Date.now();
  const lan = await T.lanFetch(`${URL_A}/node/health`, { headers: NC.nodeHeaders() });
  const took = Date.now() - t0;
  ok('3: a LAN call is not stuck behind 10 slow gateway calls (separate pools)', lan.status === 200 && took < 1500, `${took} ms`);
  const all = await Promise.all(slow);
  ok('…and the gateway calls all complete', all.every((s) => s === 200), JSON.stringify(all));
  ok('…two pools: lan and gateway', T._agentKinds().includes('lan') && T._agentKinds().includes('gateway') && T.GATEWAY_SOCKETS > T.LAN_SOCKETS, JSON.stringify(T._agentKinds()));
  A.st.gatewayDelay = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4 — a till follows its OWN server to a new address, never another\n');
{
  const Bsrv = dualServer(idB, serverHandler(idB.cert, 'srv-1'));            // another certificate claiming A's code
  const PB = await listen(Bsrv.srv);
  const Odd = dualServer(idA, serverHandler(idA.cert, 'srv-OTHER'));       // A's certificate, another machine's id
  const PO = await listen(Odd.srv);
  const codeA = T.securityCode(idA.cert);
  NH.noteServerInfo({ device_id: 'srv-1', branch_id: 'br-1', protocol: 2 });

  // The till's server "moves": the configured address is dead; A now answers at URL_A (as if DHCP moved it).
  const dead = net.createServer(); const deadPort = await listen(dead); dead.close();
  const OLD = `http://127.0.0.1:${deadPort}`;
  C.saveDeviceConfig({ node_url: OLD });
  I.noteNodeTarget(I.nodeTargetKey(OLD, 'SECRET-1'));
  db.prepare(`DELETE FROM maintenance_state WHERE key = 'node_rearm_skip'`).run();
  q.run('orders', 'f-del', JSON.stringify({ id: 'f-del', seq: 9 }), 'delivered', 1, null);
  NH._resetNodeHealth(); NF._resetFollow();
  NH.noteServerInfo({ device_id: 'srv-1', branch_id: 'br-1', protocol: 2 });

  const heardAll = async () => [
    { url: `http://127.0.0.1:${PB}`, ip: '127.0.0.1', port: PB, business: 'Shop', server: 'Fake', fp: codeA },
    { url: `http://127.0.0.1:${PO}`, ip: '127.0.0.1', port: PO, business: 'Shop', server: 'Odd', fp: codeA },
  ];
  ok('4: not while the server answers (no failed health checks)', (await NF.followMovedServer({ listen: heardAll })).outcome === 'not_due');
  await NC.checkNodeHealth(); await NC.checkNodeHealth();
  ok('(two failed health checks recorded)', NH.channelState('health').failures >= 2, JSON.stringify(NH.channelState('health')));
  let t = Date.now();
  const r1 = await NF.followMovedServer({ listen: heardAll, now: t });
  ok('4: another certificate claiming the code is never followed; nor the same certificate on another machine',
    r1.outcome === 'not_heard' && C.getDeviceConfig().node_url === OLD, JSON.stringify(r1));
  ok('4: at most one look every two minutes', (await NF.followMovedServer({ listen: async () => [{ url: URL_A, fp: codeA }], now: t + 1000 })).outcome === 'not_due');
  t += NF.FOLLOW_EVERY_MS + 1;
  ok('4: a beacon with no fingerprint (an older server) is not followed',
    (await NF.followMovedServer({ listen: async () => [{ url: URL_A, ip: '127.0.0.1', port: PA, business: null, server: null, fp: null }], now: t })).outcome === 'not_heard'
    && C.getDeviceConfig().node_url === OLD);
  t += NF.FOLLOW_EVERY_MS + 1;
  const r2 = await NF.followMovedServer({ listen: async () => [...(await heardAll()), { url: URL_A, ip: '127.0.0.1', port: PA, business: 'Shop', server: 'Server', fp: codeA }], now: t });
  ok('4: its own server (same certificate byte for byte, same device id) is followed to the new address',
    r2.outcome === 'followed' && C.getDeviceConfig().node_url === URL_A, JSON.stringify(r2));
  ok('…with no re-offer: the target moved with it ("same"), nothing delivered went pending',
    I.noteNodeTarget(I.nodeTargetKey(URL_A, 'SECRET-1')) === 'same' && qrow('f-del').status === 'delivered' && !I.nodeRearmSkipOwed());
  ok('…and the Tech page can say where it went', NF.lastFollowLook()?.proven === true && NF.lastFollowLook()?.url === URL_A);

  // An unpinned till never follows on a beacon alone.
  T.setTillPin(null);
  C.saveDeviceConfig({ node_url: OLD });
  t += NF.FOLLOW_EVERY_MS + 1;
  const r3 = await NF.followMovedServer({ listen: async () => [{ url: URL_A, ip: '127.0.0.1', port: PA, business: null, server: null, fp: codeA }], now: t });
  ok('4: an unpinned till does not follow by itself (a beacon is not proof) — it only notes where one was heard',
    r3.outcome === 'not_pinned' && C.getDeviceConfig().node_url === OLD && NF.lastFollowLook()?.proven === false, JSON.stringify(r3));
  T.setTillPin(idA.cert, { confirmed: true });
  C.saveDeviceConfig({ node_url: URL_A });

  const msg = B.buildBeacon({ port: 4100, business: 'Shop', server: 'S', fp: codeA });
  const f = B.parseBeacon(msg, '192.168.1.20');
  ok('4: the beacon carries the fingerprint (and still no secret, no ids)', f?.fp === codeA && !/secret|token|device|branch_id|business_id/i.test(msg.toString()), msg.toString());
  ok('…a malformed fingerprint is dropped', B.parseBeacon(Buffer.from(JSON.stringify({ magic: B.BEACON_MAGIC, port: 4100, fp: 'nope' })), '192.168.1.20')?.fp === null);
  ok('…the server announces its own', /fp: tlsCert \? securityCode\(tlsCert\) : null/.test(read('src/main/nodeServer.ts')));
  ok('…the till looks on its replication beat, only after failures', /const f = await followMovedServer\(\);/.test(read('src/main/syncEngine.ts')));
  Bsrv.close(); Odd.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5 — health and backlog\n');
{
  C.saveDeviceConfig({ node_url: FAKE });
  T.setTillPin(null);
  NH._resetNodeHealth();
  fake.sinceStatus = 401; fake.sinceError = 'This till has not joined this branch server — join it from the till\'s setup (Find my server), and allow it at the server.';
  ok('(a 401 on /node/since)', await NC.pullNodeDistribution({}) === null);
  ok('5: the since channel records the server\'s own words and the status', NH.channelState('since').lastStatus === 401 && /not joined/.test(NH.channelState('since').lastError ?? ''));
  ok('5: a device-key refusal is NOT called an access-code problem', G.nodeRefusal()?.reason === 'device_key', JSON.stringify(G.nodeRefusal()));
  const logPath = SE.getSyncStatus().logPath;
  ok('7: a 401 on a keyed route is logged in one clear sentence', fs.readFileSync(logPath, 'utf8').includes('A501: the branch server refused this till on /node/since (HTTP 401): This till has not joined'));
  fake.sinceStatus = undefined;
  await NC.pullNodeDistribution({});
  ok('…and clears with the next accepted keyed answer', G.nodeRefusal() === null && NH.channelState('since').failures === 0);
  q.run('orders', 'b-1', JSON.stringify({ id: 'b-1', seq: 1 }), 'failed', 5, 'bill clash');
  const s = SE.getSyncStatus();
  ok('5: the backlog reaches the manager\'s status: failed, why, and the oldest waiting',
    s.nodeBacklog.failed >= 1 && s.nodeBacklog.failedReason === 'bill clash' && 'oldestPendingAt' in s.nodeBacklog, JSON.stringify(s.nodeBacklog));
  db.prepare(`DELETE FROM node_queue WHERE row_id = 'b-1'`).run();
  ok('5: the gateway records its own channel', /noteChannelOk\('gateway', now\)/.test(read('src/main/cloudGateway.ts')) && /noteChannelError\('gateway'/.test(read('src/main/cloudGateway.ts')));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n6 — the distribution and numbering queries use the (device_id, seq) index\n');
{
  const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');
  for (const table of I.REPLICATED_TABLES) {
    const p = plan(I.distributionSql(table), 'dev-T2', 0, 10);
    ok(`6: distribution uses the index — ${table}`, /USING (COVERING )?INDEX/.test(p) && !new RegExp(`SCAN ${table}( |$)(?!USING)`).test(p.replace(/USING (COVERING )?INDEX \S+/g, 'USING')), p);
  }
  const un = I.unnumberedSql('orders', 'dev-T1');
  const p2 = plan(un.sql, ...un.args, 10);
  ok('6: numbering this till\'s own rows uses the index', /USING (COVERING )?INDEX/.test(p2), p2);
  ok('6: a device with no id still matches NULL or \'\' (what COALESCE matched)', I.deviceScope(null).sql.includes('IS NULL') && I.deviceScope(null).args.length === 0 && I.deviceScope('x').sql === 'device_id = ?');
  ok('…and collectDistribution still serves each origin\'s rows', I.collectDistribution('dev-ZZ', {}, 500).batches.some((b) => b.device_id === 'dev-T2' && b.table === 'orders'));
  ok('…no COALESCE(device_id,…) left in distribution / numbering / the outbox scan',
    !/COALESCE\(device_id,''\) = COALESCE\(\?,''\)/.test(read('src/main/nodeIngest.ts').split('export function emitRefundEvents')[0].split('export function applyPendingEvents')[0]));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n7 — /node/health names the protocol; an older server or till is named\n');
{
  const nodeCfg = { ...C.getDeviceConfig() };
  C.saveDeviceConfig({ device_role: 'node', node_url: null, device_id: 'dev-SRV' });
  NS.startNodeServer();
  await sleep(300);
  const port = NS.getNodePort();
  const secret = C.getDeviceConfig().node_secret;
  const res = await realFetch(`http://127.0.0.1:${port}/node/health`, { headers: { 'X-Node-Secret': secret } });
  const hb = await res.json();
  ok('7: /node/health reports protocol, min_till_protocol and capabilities',
    hb.protocol === NH.NODE_PROTOCOL && hb.min_till_protocol === NH.MIN_TILL_PROTOCOL && hb.capabilities.includes('beacon_identity') && hb.device_id === 'dev-SRV', JSON.stringify(hb));
  NS.stopNodeServer();
  C.saveDeviceConfig({ ...nodeCfg, device_role: 'till' });

  NH.noteServerInfo({ device_id: 'srv-1', branch_id: 'br-1' });   // a server before A501 reports no protocol
  const h = await H['node:syncHealth'](null, undefined);
  ok('7: a server that reports no protocol is older — "Update the branch server" on the Tech page',
    h.serverOlder === true && h.server.protocol === 1 && /Update the branch server/.test(read('src/renderer/components/BranchSyncPanel.tsx')), JSON.stringify({ o: h.serverOlder, p: h.server?.protocol }));
  NH.noteServerInfo({ device_id: 'srv-1', branch_id: 'br-1', protocol: 2, min_till_protocol: 99 });
  ok('7: a server that needs a newer till says so — the till is named older, in the log too',
    NH.protocolVerdict().tillOlder === true && fs.readFileSync(SE.getSyncStatus().logPath, 'utf8').includes('this till is older than the branch server expects'));
  NH.noteServerInfo({ device_id: 'srv-1', branch_id: 'br-1', protocol: 2, min_till_protocol: 1 });
  ok('…and a current server is neither', !NH.protocolVerdict().serverOlder && !NH.protocolVerdict().tillOlder);
}

A.close(); fakeSrv.close(); fakeSrv.closeAllConnections?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
