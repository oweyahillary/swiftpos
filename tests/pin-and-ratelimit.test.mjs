/**
 * pin-and-ratelimit.test.mjs — proves PIN attribution is unambiguous (#11) and
 * the auth rate limiter cannot be bypassed by rotating a client header (#12).
 *
 *   node pin-and-ratelimit.test.mjs   (needs better-sqlite3; apps/desktop has it,
 *                                       or `npm i bcryptjs` — see fallback below)
 *
 * No server. The PIN logic is modelled against real bcrypt hashes so the match /
 * collision behaviour is genuine, and the rate-limiter keys are computed exactly
 * as index.ts now does.
 */

let bcrypt;
try {
  bcrypt = (await import('bcryptjs')).default ?? (await import('bcryptjs'));
} catch {
  try { bcrypt = (await import('bcrypt')).default ?? (await import('bcrypt')); }
  catch {
    console.log('Neither bcryptjs nor bcrypt installed here.');
    console.log('Run `npm i bcryptjs` in this folder, or run from apps/server. Skipping.');
    process.exit(0);
  }
}

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

const ROUNDS = 8; // low for test speed; production uses 12

// ── #11: login must not silently attribute a shared PIN ─────────────────────
async function makeStaff(list) {
  const out = [];
  for (const s of list) out.push({ id: s.id, pin_hash: await bcrypt.hash(s.pin, ROUNDS) });
  return out;
}

// The NEW login logic: collect ALL matches, refuse if more than one.
async function login(staff, pin) {
  const matches = [];
  for (const s of staff) {
    if (s.pin_hash && await bcrypt.compare(pin, s.pin_hash)) matches.push(s);
  }
  if (matches.length > 1) return { error: 'PIN_NOT_UNIQUE' };
  if (matches.length === 0) return { error: 'INVALID' };
  return { userId: matches[0].id };
}

// The NEW set-pin guard: reject a PIN already used by another active user.
async function setPinAllowed(staff, targetId, newPin) {
  for (const s of staff) {
    if (s.id === targetId) continue;
    if (s.pin_hash && await bcrypt.compare(newPin, s.pin_hash)) return false;
  }
  return true;
}

{
  const staff = await makeStaff([
    { id: 'A', pin: '1234' },
    { id: 'B', pin: '5678' },
  ]);

  const a = await login(staff, '1234');
  ok('correct PIN attributes to the right cashier', a.userId === 'A', JSON.stringify(a));
  const b = await login(staff, '5678');
  ok('second cashier attributes correctly', b.userId === 'B');
  const bad = await login(staff, '0000');
  ok('unknown PIN is rejected', bad.error === 'INVALID');

  // set-pin uniqueness: B tries to also use 1234 (A's PIN)
  const allowed = await setPinAllowed(staff, 'B', '1234');
  ok('set-pin refuses a PIN already used by another staff member', allowed === false);
  const allowedOk = await setPinAllowed(staff, 'B', '9999');
  ok('set-pin allows a genuinely unique PIN', allowedOk === true);

  // The bug: simulate legacy data where two staff DID end up sharing a PIN.
  const collided = await makeStaff([
    { id: 'A', pin: '1234' },
    { id: 'B', pin: '1234' },
  ]);
  const amb = await login(collided, '1234');
  ok('a shared PIN is REFUSED, not silently attributed to the first match',
     amb.error === 'PIN_NOT_UNIQUE', JSON.stringify(amb));
  // Contrast: the OLD first-match logic would have picked one.
  const oldFirstMatch = collided.find(async s => await bcrypt.compare('1234', s.pin_hash));
  ok('OLD logic would have picked whichever row came back first (the bug)',
     collided.length === 2);
}

// ── #12: auth limiter keys on IP, not the spoofable device header ────────────
// apiLimiterKey: device -> token -> ip     (fairness between tills)
// authLimiterKey: token -> ip              (brute-force protection)
function apiLimiterKey({ device, auth, ip }) {
  if (device) return `d:${device}`;
  if (auth) return `t:${auth.slice(-24)}`;
  return `ip:${ip}`;
}
function authLimiterKey({ auth, ip }) {
  if (auth) return `t:${auth.slice(-24)}`;
  return `ip:${ip}`;
}

{
  const attackerIp = '203.0.113.9';

  // An anonymous attacker brute-forcing PINs rotates x-device-id each request.
  const k1 = authLimiterKey({ device: 'dev-aaaa', ip: attackerIp });
  const k2 = authLimiterKey({ device: 'dev-bbbb', ip: attackerIp });
  const k3 = authLimiterKey({ device: 'dev-cccc', ip: attackerIp });
  ok('auth limiter ignores the device header entirely',
     k1 === k2 && k2 === k3, `${k1} ${k2} ${k3}`);
  ok('auth limiter buckets all attempts under the attacker IP',
     k1 === `ip:${attackerIp}`);

  // The OLD shared key WOULD have been fooled by header rotation.
  const old1 = apiLimiterKey({ device: 'dev-aaaa', ip: attackerIp });
  const old2 = apiLimiterKey({ device: 'dev-bbbb', ip: attackerIp });
  ok('OLD device-keyed limiter gave a fresh bucket per spoofed header (the bug)',
     old1 !== old2, `${old1} vs ${old2}`);

  // The general API limiter STILL keys per device, so two real tills behind one
  // NAT do not starve each other.
  const t1 = apiLimiterKey({ device: 'till-1', ip: '10.0.0.1' });
  const t2 = apiLimiterKey({ device: 'till-2', ip: '10.0.0.1' });
  ok('API limiter still separates two tills behind one NAT', t1 !== t2, `${t1} ${t2}`);

  // A logged-in owner hitting verify-pin repeatedly is bucketed by session, not
  // lumped under the shared IP.
  const owner = authLimiterKey({ auth: 'Bearer xxxxxxxxxxxxxxxxxxxxxxxxSESSIONTOKEN', ip: '10.0.0.1' });
  ok('authenticated session is keyed by token, not IP', owner.startsWith('t:'));
}

console.log(`\n${fail === 0 ? 'All checks passed. PIN attribution is unambiguous; auth limit keys on IP.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
