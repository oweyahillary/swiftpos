/**
 * refresh-handshake.test.mjs — A477: a till's renewal is a handshake (SYN / SYN-ACK / ACK), its key is bound to its
 * machine, and every till holds a device secret.
 *
 * Owner, 2026-10-14 (a branch server signed out on 2026-10-12: every renewal answered TOKEN_REPLAYED, its device secret
 * was missing, a technician had to rejoin it): "renewal like SYN / SYN-ACK / ACK" so an honest till is never locked out
 * by a crash, an update restart, a lost reply or a slow line; the key bound to the machine "to confirm that this till is
 * in the system".
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/refresh-handshake.test.mjs
 *
 * RUNS the pure decisions (lib/refreshHandshake.js) and the COMPILED /api/auth routes over HTTP (database in memory —
 * migration 131's columns emulated; JWTs signed with a per-run random secret).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - /refresh revoking the consumed token again (revokeConsumed always true)     → "rotate: the old token still works until the ack" fails
 *   - the 'stale' decision answering 'replay' for a till's session                → "an outdated till token: TOKEN_STALE, the session alive" fails
 *   - identityDecision passing when neither guid nor serial matches                → "another computer: DEVICE_MISMATCH" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
if (!fs.existsSync(path.join(DIST, 'routes/auth.js'))) {
  console.log('\nCannot load apps/server/dist/routes/auth.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const H = require(path.join(DIST, 'lib/refreshHandshake.js'));
const A = require(path.join(DIST, 'jobs/ownerAlertsDecision.js'));
const jwt = require('jsonwebtoken');

const BZ = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const PERSON = '44444444-4444-4444-8444-444444444444';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const future = new Date(Date.now() + 86_400_000).toISOString();
const G1 = sha('guid-of-till-1'), S1 = sha('serial-of-till-1'), G2 = sha('guid-of-another-pc'), S2 = sha('serial-of-another-pc');
const MACHINE = { 'X-Device-Mac': 'aa:bb:cc:dd:ee:01', 'X-Device-Guid': G1, 'X-Device-Serial': S1 };

// ── the pure decisions ────────────────────────────────────────────────────────
console.log('\nThe handshake decision (pure)\n');
const D = (row, successor, deviceSession = true, handshake = true) => H.refreshHandshakeDecision({ row, successor, deviceSession, handshake });
const live = { revokedAt: null, ackedAt: 'x', replacedBy: null, expiresAt: future };
await ok('the live, confirmed head → rotate (nothing revoked yet)', () => {
  assert.deepEqual(D(live, null), { action: 'rotate', implicitAck: false, revokeConsumed: false });
});
await ok('re-asked before the ack (successor not confirmed) → reask, no session touched — till or person', () => {
  const s = { revokedAt: null, ackedAt: null, replacedBy: null };
  assert.equal(D({ ...live, replacedBy: 's' }, s).action, 'reask');
  assert.equal(D({ ...live, replacedBy: 's' }, s, false).action, 'reask');
});
await ok('a successor that was itself revoked (an earlier re-ask) → reask', () => {
  assert.equal(D({ ...live, replacedBy: 's' }, { revokedAt: 'x', ackedAt: null, replacedBy: null }).action, 'reask');
});
await ok('the first use of an unconfirmed successor → implicit ack, then rotate', () => {
  assert.deepEqual(D({ ...live, ackedAt: null }, null), { action: 'rotate', implicitAck: true, revokeConsumed: false });
});
await ok('revoked (acked away), its successor confirmed and the head: a till → stale; a browser → A88 grace (reask)', () => {
  const s = { revokedAt: null, ackedAt: 'x', replacedBy: null };
  assert.equal(D({ ...live, revokedAt: 'x', replacedBy: 's' }, s, true).action, 'stale');
  assert.equal(D({ ...live, revokedAt: 'x', replacedBy: 's' }, s, false).action, 'reask');
});
await ok('revoked, the chain moved on (successor rotated): a till → stale (refused alone); a person → replay (revoke all, as before)', () => {
  const s = { revokedAt: null, ackedAt: 'x', replacedBy: 'next' };
  assert.equal(D({ ...live, revokedAt: 'x', replacedBy: 's' }, s, true).action, 'stale');
  assert.equal(D({ ...live, revokedAt: 'x', replacedBy: 's' }, s, false).action, 'replay');
});
await ok('revoked with no successor (logout): a till → stale; a person → replay', () => {
  assert.equal(D({ ...live, revokedAt: 'x' }, null, true).action, 'stale');
  assert.equal(D({ ...live, revokedAt: 'x' }, null, false).action, 'replay');
});
await ok('live but its successor already confirmed (an ack that stopped half-way) → outdated: stale / replay', () => {
  const s = { revokedAt: null, ackedAt: 'x', replacedBy: null };
  assert.equal(D({ ...live, replacedBy: 's' }, s, true).action, 'stale');
  assert.equal(D({ ...live, replacedBy: 's' }, s, false).action, 'replay');
});
await ok('expired → expired', () => { assert.equal(D({ ...live, expiresAt: '2020-01-01T00:00:00Z' }, null).action, 'expired'); });
await ok('before migration 131 (no acked_at): the old rotation — revoke at rotation, A88 grace for a lost reply', () => {
  const old = { revokedAt: null, replacedBy: null, expiresAt: future };
  assert.deepEqual(D(old, null, true, false), { action: 'rotate', implicitAck: false, revokeConsumed: true });
  assert.equal(D({ ...old, revokedAt: 'x', replacedBy: 's' }, { revokedAt: null, replacedBy: null }, true, false).action, 'reask');
  assert.equal(D({ ...old, revokedAt: 'x', replacedBy: 's' }, { revokedAt: 'x', replacedBy: null }, false, false).action, 'replay');
});

console.log('\nThe machine decision (pure)\n');
await ok('no guid and no serial presented (a till from before A477) → pass, nothing stored', () => {
  assert.deepEqual(H.identityDecision({ guidHash: G1 }, { mac: 'aa:bb:cc:dd:ee:01' }), { verdict: 'pass', update: null, matched: false });
});
await ok('nothing on record → pass and store (trust on first use)', () => {
  const d = H.identityDecision({}, { mac: 'aa:bb:cc:dd:ee:01', guidHash: G1, serialHash: S1 });
  assert.equal(d.verdict, 'pass'); assert.deepEqual(d.update, { machine_guid_hash: G1, serial_hash: S1, mac_address: 'aa:bb:cc:dd:ee:01' });
});
await ok('the guid matches (a new serial, a new MAC) → pass, both recorded', () => {
  const d = H.identityDecision({ guidHash: G1, serialHash: S1, mac: 'aa:bb:cc:dd:ee:01' }, { mac: 'aa:bb:cc:dd:ee:02', guidHash: G1, serialHash: S2 });
  assert.equal(d.verdict, 'pass'); assert.equal(d.matched, true); assert.deepEqual(d.update, { serial_hash: S2, mac_address: 'aa:bb:cc:dd:ee:02' });
});
await ok('the serial matches (Windows reinstalled: a new guid) → pass', () => {
  assert.equal(H.identityDecision({ guidHash: G1, serialHash: S1 }, { guidHash: G2, serialHash: S1 }).verdict, 'pass');
});
await ok('only the MAC differs → pass, the MAC updated', () => {
  const d = H.identityDecision({ guidHash: G1, serialHash: S1, mac: 'aa:bb:cc:dd:ee:01' }, { mac: 'aa:bb:cc:dd:ee:09', guidHash: G1, serialHash: S1 });
  assert.equal(d.verdict, 'pass'); assert.deepEqual(d.update, { mac_address: 'aa:bb:cc:dd:ee:09' });
});
await ok('on record and presented, NEITHER matches → mismatch', () => {
  assert.equal(H.identityDecision({ guidHash: G1, serialHash: S1 }, { guidHash: G2, serialHash: S2 }).verdict, 'mismatch');
  assert.equal(H.identityDecision({ guidHash: G1 }, { guidHash: G2 }).verdict, 'mismatch');
});
await ok('nothing comparable (on record a guid, presented a serial) → pass, the serial recorded', () => {
  const d = H.identityDecision({ guidHash: G1 }, { serialHash: S1 });
  assert.equal(d.verdict, 'pass'); assert.deepEqual(d.update, { serial_hash: S1 });
});
await ok('malformed headers count as absent', () => {
  assert.deepEqual(H.presentedIdentity((n) => ({ 'x-device-guid': 'not-a-hash', 'x-device-serial': 'raw-serial', 'x-device-mac': 'zz' })[n]), { mac: null, guidHash: null, serialHash: null });
});

console.log('\nThe security alert (pure)\n');
await ok('once per incident, only a recent one', () => {
  const now = new Date('2026-10-14T10:00:00Z');
  const d = { id: 'd1', security_alert_at: '2026-10-14T09:00:00Z' };
  const first = A.decideSecurityAlert(d, {}, now);
  assert.equal(first.send, true);
  assert.equal(A.decideSecurityAlert(d, { [first.key]: now.toISOString() }, now).send, false);
  assert.equal(A.decideSecurityAlert({ id: 'd1', security_alert_at: '2026-10-10T09:00:00Z' }, {}, now).send, false);
  assert.equal(A.decideSecurityAlert({ id: 'd1' }, {}, now).send, false);
});

// ── the routes, over HTTP ─────────────────────────────────────────────────────
let db, handshake = true;
const reset = (opts = {}) => {
  handshake = opts.handshake ?? true;
  db = {
    businesses: [{ id: BZ, name: 'Pollo', currency: 'KES', type: 'restaurant', status: 'active' }],
    branches: [{ id: BR, business_id: BZ, name: 'Town' }],
    users: [{ id: PERSON, business_id: BZ, status: 'active', permissions_version: 1 }],
    device_enrolment_codes: ['A', 'B', 'C'].map((x, i) => ({ id: `c${i}`, business_id: BZ, branch_id: BR, code_hash: sha(`JOIN-${x}`), status: 'active', expires_at: future })),
    user_devices: [],
    refresh_tokens: [],
  };
};
let nextId = 1;
supabase.from = (table) => {
  const f = []; let patch = null; let inserted = null;
  const rows = () => (db[table] ?? []).filter((r) => f.every(([k, fn]) => fn(r[k])));
  const run = () => {
    if (inserted) return inserted;
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit; }
    return rows();
  };
  const q = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'eq') return (k, v) => { f.push([k, (x) => x === v]); return q; };
      if (prop === 'in') return (k, a) => { f.push([k, (x) => a.includes(x)]); return q; };
      if (prop === 'is') return (k, v) => { f.push([k, (x) => (x ?? null) === v]); return q; };
      if (prop === 'gt') return (k, v) => { f.push([k, (x) => String(x) > String(v)]); return q; };
      if (prop === 'update') return (p) => { patch = p; return q; };
      if (prop === 'insert') return (r) => {
        const list = (db[table] ??= []);
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({
          id: `row-${nextId++}`, created_at: new Date().toISOString(), revoked_at: null, replaced_by: null,
          // migration 131: refresh_tokens.acked_at exists (NULL by default); before it, the column is not there
          ...(table === 'refresh_tokens' && handshake ? { acked_at: null } : {}), ...x,
        }));
        list.push(...inserted); return q;
      };
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (prop === 'single') return () => { const r = run()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'none' } }); };
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const jtiOf = (t) => sha(jwt.decode(t).jti);
const rowOf = (t) => db.refresh_tokens.find((r) => r.jti === jtiOf(t));
const till = () => db.user_devices.find((d) => d.device_id === 'dev-T1');
const join = (code, headers = MACHINE, extra = {}) => post('/api/auth/enrol/redeem', { business_id: BZ, code, device_id: 'dev-T1', ...extra }, headers);
const renew = (t, headers = MACHINE) => post('/api/auth/refresh', { refreshToken: t }, { 'X-Device-Id': 'dev-T1', ...headers });
const ack = (t, headers = MACHINE) => post('/api/auth/refresh/ack', { refreshToken: t }, headers);

try {
  console.log('\nThe handshake, over HTTP\n');
  let T0, T1, T1b, T2, T3;
  await ok('rotate: a new token (unconfirmed), and the old token still works until the ack', async () => {
    reset();
    T0 = (await join('JOIN-A')).body.refreshToken;
    const r = await renew(T0);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.ack, true, 'the till is asked to confirm');
    T1 = r.body.refreshToken;
    assert.equal(rowOf(T0).revoked_at, null, 'the old token is NOT revoked before the ack');
    assert.equal(rowOf(T0).replaced_by, rowOf(T1).id); assert.equal(rowOf(T1).acked_at, null);
  });
  await ok('re-ask before the ack (the reply was lost): a fresh successor, the first one retired, the session alive', async () => {
    const r = await renew(T0);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    T1b = r.body.refreshToken;
    assert.notEqual(T1b, T1);
    assert.ok(rowOf(T1).revoked_at, 'the successor that never arrived is retired');
    assert.equal(rowOf(T0).revoked_at, null); assert.equal(rowOf(T0).replaced_by, rowOf(T1b).id);
    assert.equal(db.refresh_tokens.filter((t) => !t.revoked_at).length, 2, 'T0 and its fresh successor — nothing else touched');
  });
  await ok('ack: the new token confirmed, the old one revoked', async () => {
    const r = await ack(T1b);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.acked, true);
    assert.ok(rowOf(T1b).acked_at); assert.ok(rowOf(T0).revoked_at);
    assert.equal((await ack(T1b)).status, 200, 'harmless to repeat');
  });
  await ok('implicit ack: an older till never calls /ack — presenting the new token confirms it and retires the old', async () => {
    T2 = (await renew(T1b)).body.refreshToken;
    assert.equal(rowOf(T1b).revoked_at, null);
    const r = await renew(T2);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    T3 = r.body.refreshToken;
    assert.ok(rowOf(T2).acked_at, 'T2 confirmed by its use'); assert.ok(rowOf(T1b).revoked_at, 'T1 retired');
  });
  await ok('an outdated till token: TOKEN_STALE — refused alone, the session alive, the owner alerted', async () => {
    const r = await renew(T0);
    assert.equal(r.status, 401); assert.equal(r.body.code, 'TOKEN_STALE');
    assert.equal(rowOf(T3).revoked_at, null, 'the live token is untouched');
    assert.equal(rowOf(T2).revoked_at, null, 'its parent (not yet confirmed away) is untouched');
    assert.ok(till().security_alert_at && /outdated copy/.test(till().security_alert_reason), JSON.stringify(till()));
    assert.equal((await renew(T3)).status, 200, 'the till renews on as before');
  });
  await ok('an ack for a token already replaced → 401 TOKEN_STALE (nothing changes)', async () => {
    const before = JSON.stringify(db.refresh_tokens);
    const r = await ack(T1);
    assert.equal(r.status, 401); assert.equal(r.body.code, 'TOKEN_STALE'); assert.equal(JSON.stringify(db.refresh_tokens), before);
  });
  await ok('a till the owner retired: its old key refused, but no "another computer" alert for a deliberate retire', async () => {
    reset();
    const t0 = (await join('JOIN-A')).body.refreshToken;
    const t1 = (await renew(t0)).body.refreshToken;
    await ack(t1);
    till().retired_at = new Date().toISOString();
    const r = await renew(t0);
    assert.equal(r.status, 401); assert.equal(till().security_alert_at ?? null, null, JSON.stringify(till()));
  });
  await ok('a person\'s web session replayed: every token of the session revoked, exactly as before (TOKEN_REPLAYED)', async () => {
    reset();
    const payload = { userId: PERSON, businessId: BZ, branchId: BR, isOwner: false, permissionKeys: ['orders.view'], permissionsVersion: 1, sessionId: 'web-s', surface: 'web' };
    const jti = 'w0';
    db.refresh_tokens.push({ id: 'w-0', jti: sha(jti), user_id: PERSON, business_id: BZ, session_id: 'web-s', device_hint: 'Mozilla', session_kind: 'web', revoked_at: null, replaced_by: null, acked_at: '2026-10-14T00:00:00Z', expires_at: future });
    const W0 = jwt.sign({ ...payload, jti, tokenType: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const W1 = (await post('/api/auth/refresh', { refreshToken: W0 })).body.refreshToken;
    const W2 = (await post('/api/auth/refresh', { refreshToken: W1 })).body.refreshToken;   // W1's use confirms it, retires W0
    assert.ok(W2 && rowOf(W0).revoked_at);
    const r = await post('/api/auth/refresh', { refreshToken: W0 });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'TOKEN_REPLAYED');
    assert.equal(db.refresh_tokens.filter((t) => t.session_id === 'web-s' && !t.revoked_at).length, 0, 'the whole session revoked');
  });
  await ok('signing out with a token not confirmed yet retires the one it replaced too', async () => {
    reset();
    const t0 = (await join('JOIN-A')).body.refreshToken;
    const t1 = (await renew(t0)).body.refreshToken;
    await post('/api/auth/logout', { refreshToken: t1 });
    assert.ok(rowOf(t1).revoked_at && rowOf(t0).revoked_at, 'neither can renew after the sign-out');
  });
  await ok('before migration 131 (no acked_at column): the old rotation — the consumed token revoked, no ack asked', async () => {
    reset({ handshake: false });
    const t0 = (await join('JOIN-A')).body.refreshToken;
    const r = await renew(t0);
    assert.equal(r.status, 200); assert.equal(r.body.ack, undefined); assert.ok(rowOf(t0).revoked_at);
    assert.equal((await renew(t0)).status, 200, 'A88: a lost reply is still re-issued');
  });

  console.log('\nThe machine, over HTTP\n');
  await ok('first use: the machine is recorded at enrolment (hashes only)', async () => {
    reset();
    await join('JOIN-A');
    assert.equal(till().machine_guid_hash, G1); assert.equal(till().serial_hash, S1); assert.ok(till().identity_seen_at);
  });
  await ok('a till enrolled before A477 (nothing recorded): its first renewal with the headers records it', async () => {
    reset();
    const t0 = (await join('JOIN-A', {})).body.refreshToken;
    assert.ok(!till().machine_guid_hash);
    assert.equal((await renew(t0)).status, 200);
    assert.equal(till().machine_guid_hash, G1); assert.equal(till().serial_hash, S1);
  });
  await ok('the guid matches (the BIOS serial changed) → renews; MAC-only change → renews, MAC updated', async () => {
    reset();
    let t = (await join('JOIN-A')).body.refreshToken;
    let r = await renew(t, { ...MACHINE, 'X-Device-Serial': S2 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); t = r.body.refreshToken;
    r = await renew(t, { ...MACHINE, 'X-Device-Mac': 'aa:bb:cc:dd:ee:77' });
    assert.equal(r.status, 200); assert.equal(till().mac_address, 'aa:bb:cc:dd:ee:77');
  });
  await ok('another computer (neither guid nor serial matches): DEVICE_MISMATCH — the token unspent, the session alive, the owner alerted', async () => {
    reset();
    const t0 = (await join('JOIN-A')).body.refreshToken;
    const n = db.refresh_tokens.length;
    const r = await renew(t0, { 'X-Device-Guid': G2, 'X-Device-Serial': S2 });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'DEVICE_MISMATCH');
    assert.equal(db.refresh_tokens.length, n, 'nothing minted'); assert.equal(rowOf(t0).revoked_at, null, 'nothing revoked');
    assert.ok(/another computer/.test(till().security_alert_reason ?? ''), JSON.stringify(till()));
    assert.equal((await renew(t0)).status, 200, 'the real till renews on');
  });
  await ok('…the device grant from another computer is refused the same way', async () => {
    reset();
    const j = await join('JOIN-A');
    const r = await post('/api/auth/device-token', { business_id: BZ, device_id: 'dev-T1', device_secret: j.body.deviceSecret }, { 'X-Device-Guid': G2, 'X-Device-Serial': S2 });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'DEVICE_MISMATCH');
    assert.equal((await post('/api/auth/device-token', { business_id: BZ, device_id: 'dev-T1', device_secret: j.body.deviceSecret }, MACHINE)).status, 200);
  });
  await ok('a till from before A477 (no identity headers) renews as before, nothing stored', async () => {
    reset();
    const t0 = (await join('JOIN-A', {})).body.refreshToken;
    assert.equal((await renew(t0, {})).status, 200); assert.ok(!till().machine_guid_hash);
  });
  await ok('a technician\'s rejoin records the machine it is done on', async () => {
    reset();
    await join('JOIN-A');
    const r = await join('JOIN-B', { 'X-Device-Guid': G2, 'X-Device-Serial': S2 }, { rejoin: true, branch_id: BR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(till().machine_guid_hash, G2); assert.equal(till().serial_hash, S2);
  });

  console.log('\nA device secret for every till\n');
  await ok('a till whose row holds none is given one on a renewal', async () => {
    reset();
    const t0 = (await join('JOIN-A')).body.refreshToken;
    till().device_secret_hash = null;
    const r = await renew(t0);
    assert.ok(r.body.deviceSecret && till().device_secret_hash === sha(r.body.deviceSecret));
  });
  await ok('a till that lost its copy (X-Device-Secret-Missing: 1), from its own machine, gets a fresh one (the old hash replaced)', async () => {
    reset();
    const j = await join('JOIN-A');
    const old = till().device_secret_hash;
    const r = await renew(j.body.refreshToken, { ...MACHINE, 'X-Device-Secret-Missing': '1' });
    assert.ok(r.body.deviceSecret); assert.notEqual(till().device_secret_hash, old);
    assert.equal(till().device_secret_hash, sha(r.body.deviceSecret));
    const g = await post('/api/auth/device-token', { business_id: BZ, device_id: 'dev-T1', device_secret: j.body.deviceSecret }, MACHINE);
    assert.equal(g.status, 401, 'the lost copy no longer works');
  });
  await ok('…but not without the machine (no identity headers): no secret handed out', async () => {
    reset();
    const j = await join('JOIN-A');
    const r = await renew(j.body.refreshToken, { 'X-Device-Secret-Missing': '1' });
    assert.equal(r.status, 200); assert.equal(r.body.deviceSecret, undefined);
  });

  console.log('\nWired (source)\n');
  await ok('the renewals\' own counter covers the ack; a bulk revoke still goes through the session id only', async () => {
    const L = require(path.join(DIST, 'lib/authLimits.js'));
    assert.ok(L.isRenewalPath('/refresh/ack'));
    const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/auth.ts'), 'utf8');
    assert.ok(/decision\.action === 'replay'[\s\S]{0,400}\.eq\('session_id', dbRow\.session_id\)/.test(src));
  });
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
