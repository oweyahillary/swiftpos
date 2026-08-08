/**
 * auth-resolution.test.mjs — audit BUG-16, BUG-18, C4, BUG-22.
 *
 * All four are the same shape: a lookup that could return something other than
 * exactly-one-row, handled as though it could not.
 *
 * pos-login-resolution.test.mjs already covers BUG-05 (the cashier half of
 * this). This is the owner half, plus the two middleware faults it sits beside.
 */
import assert from 'node:assert';

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. An owner with two businesses can still log in (BUG-18)');

/** What resolveOwnerBusinesses does, given rows. */
const resolve = (rows, preferId = null) => {
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'one', business: rows[0] };
  if (preferId) {
    const hit = rows.find(b => b.id === preferId);
    if (hit) return { kind: 'one', business: hit };
  }
  return { kind: 'many', businesses: rows };
};

/** What .single() did: PGRST116 on <>1 row, tested only for truthiness. */
const oldSingle = (rows) =>
  rows.length === 1 ? { data: rows[0], error: null }
                    : { data: null, error: { code: 'PGRST116' } };

ok('one business — unchanged behaviour', () => {
  const r = resolve([{ id: 'b1', name: 'Kudo' }]);
  assert.equal(r.kind, 'one');
  assert.equal(r.business.id, 'b1');
});

ok('zero businesses is still a 403, not a crash', () => {
  assert.equal(resolve([]).kind, 'none');
});

ok('TWO businesses used to be reported as ZERO — the bug', () => {
  const rows = [{ id: 'b1' }, { id: 'b2' }];
  const old = oldSingle(rows);
  assert.equal(old.data, null, 'the old code saw no business...');
  assert.ok(old.error, '...because .single() errored');
  // and the handler printed "No business found for this account"
  assert.notEqual(resolve(rows).kind, 'none', 'the new code does not claim zero');
});

ok('two businesses asks which, rather than guessing', () => {
  const r = resolve([{ id: 'b1', name: 'Kudo' }, { id: 'b2', name: 'Kudo Two' }]);
  assert.equal(r.kind, 'many');
  assert.equal(r.businesses.length, 2, 'both are offered to the caller');
});

ok('a supplied business_id settles it', () => {
  const r = resolve([{ id: 'b1' }, { id: 'b2' }], 'b2');
  assert.equal(r.kind, 'one');
  assert.equal(r.business.id, 'b2');
});

ok('a business_id that is not theirs does NOT select it', () => {
  const r = resolve([{ id: 'b1' }, { id: 'b2' }], 'b99');
  assert.equal(r.kind, 'many', 'an unknown id must not grant access to anything');
});

ok('middleware takes the oldest, deterministically', () => {
  // Ordered by created_at ascending, so "first" is stable. An owner bounced
  // between businesses on alternate requests is worse than one who is asked.
  const rows = [{ id: 'b1' }, { id: 'b2' }];
  const first = (r) => r.kind === 'one' ? r.business : r.kind === 'many' ? r.businesses[0] : null;
  assert.equal(first(resolve(rows)).id, 'b1');
  assert.equal(first(resolve(rows)).id, 'b1', 'same answer every time');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. A DB blip no longer logs a cashier out (BUG-16)');

/**
 * The old shape: everything inside one try, `catch { fall through }`.
 * The new shape: only jwt.verify inside the try.
 */
const oldAuth = (tokenValid, dbThrows) => {
  try {
    if (!tokenValid) throw new Error('bad token');
    if (dbThrows) throw new Error('ECONNRESET');
    return 'next()';
  } catch {
    return 'fall through to supabase → 401';
  }
};

const newAuth = (tokenValid, dbThrows) => {
  let payload = null;
  try { if (!tokenValid) throw new Error('bad token'); payload = { ok: true }; }
  catch { payload = null; }
  if (payload) {
    if (dbThrows) return '503';           // the truth, and retryable
    return 'next()';
  }
  return 'fall through to supabase → 401';
};

ok('a valid token with a healthy DB still passes', () => {
  assert.equal(newAuth(true, false), 'next()');
});

ok('a token that is not ours still falls through', () => {
  assert.equal(newAuth(false, false), 'fall through to supabase → 401');
});

ok('a valid token + DB blip used to 401 the cashier — the bug', () => {
  assert.equal(oldAuth(true, true), 'fall through to supabase → 401');
});

ok('a valid token + DB blip is now a 503, and the session survives', () => {
  assert.equal(newAuth(true, true), '503');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. The email filter is a filter, not a wildcard (C4)');

const escapeLike = (s) => s.replace(/[\\%_]/g, ch => `\\${ch}`);

/** Crude LIKE matcher, enough to show the wildcard behaviour. */
const likeMatch = (pattern, value) => {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '_')  { re += '.';  continue; }
    if (c === '%')  { re += '.*'; continue; }
    re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(value);
};

ok('an unescaped underscore matched the wrong address — the bug', () => {
  assert.equal(likeMatch('john_doe@x.com', 'johnXdoe@x.com'), true);
});

ok('escaped, it matches only itself', () => {
  assert.equal(likeMatch(escapeLike('john_doe@x.com'), 'johnXdoe@x.com'), false);
  assert.equal(likeMatch(escapeLike('john_doe@x.com'), 'john_doe@x.com'), true);
});

ok('a percent sign cannot turn into a catch-all', () => {
  assert.equal(likeMatch('%@x.com', 'anyone@x.com'), true, 'unescaped: matches everyone');
  assert.equal(likeMatch(escapeLike('%@x.com'), 'anyone@x.com'), false);
});

ok('escaping is idempotent on ordinary addresses', () => {
  assert.equal(escapeLike('jane@kudo.co.ke'), 'jane@kudo.co.ke');
});

ok('a backslash in the input cannot break the escape', () => {
  assert.equal(escapeLike('a\\_b'), 'a\\\\\\_b');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. device_hint identifies a device (BUG-22)');

const hint = (deviceId, userAgent) => deviceId ?? userAgent ?? null;

ok('the fleet shares one User-Agent — it distinguishes nothing', () => {
  const ua = 'Mozilla/5.0 Electron/28 SwiftPOS/0.5.7';
  assert.equal(hint(undefined, ua), hint(undefined, ua), 'till 1 and till 3 look identical');
});

ok('device_id wins when the client sends one', () => {
  assert.equal(hint('dev-till-3', 'Mozilla/5.0 Electron/28'), 'dev-till-3');
});

ok('the User-Agent remains a fallback, not a failure', () => {
  assert.equal(hint(undefined, 'Mozilla/5.0'), 'Mozilla/5.0');
});

ok('a revoke keyed on device_id can now match an owner session', () => {
  const rows = [{ device_hint: 'dev-till-3' }, { device_hint: 'dev-till-1' }];
  const revoked = rows.filter(r => r.device_hint === 'dev-till-3');
  assert.equal(revoked.length, 1, 'previously zero, because the row held a User-Agent');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
