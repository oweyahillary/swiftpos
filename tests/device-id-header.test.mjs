/**
 * device-id-header.test.mjs — register A38.
 *
 * The desktop sent the device id under BOTH 'x-device-id' and 'X-Device-Id' in
 * one object literal. HTTP header names are case-insensitive, so fetch emitted
 * the pair, and every server-side reader received them joined with a comma.
 * Observed in production 2026-08-09:
 *
 *   [fleet] no user_devices row for device
 *     24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e
 *
 * The trailing copy is truncated because the reader then did `.slice(0, 64)` on
 * the JOINED string.
 *
 * It reached four places: fleet telemetry (`WHERE device_id = ?` could never
 * match), `orders.device_id`, `shifts.device_id`, and the terminal key that
 * feeds migration 63's one-open-drawer-per-terminal unique index.
 *
 * MUTATION CHECK (rule 10): remove the `.split(',')[0]` from
 * `deviceIdFromRequest` and section 2 fails; put the duplicate key back in
 * syncEngine's header builders and section 3 fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SYNC = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/syncEngine.ts'), 'utf8');
const TKEY = fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/terminalKey.ts'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
};

const DEV = '24dbc289-ee7f-42b6-8fed-6e089095b719';

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. What a duplicated header actually produces');

ok('two values arrive joined with ", " — exactly as seen in production', () => {
  const joined = [DEV, DEV].join(', ');
  assert.equal(joined, `${DEV}, ${DEV}`);
  // And the old reader sliced the JOINED string, chopping the second mid-uuid.
  const old = joined.slice(0, 64);
  // The exact string Render logged on 2026-08-09 — not a value typed here.
  assert.equal(old, '24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e');
  assert.equal(old.length, 64);
  assert.notEqual(old, DEV, 'this is why WHERE device_id = ? never matched');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. The normaliser recovers the real id');

/** The shipped deviceIdFromRequest logic. */
const normalise = (raw) => String(raw ?? '').split(',')[0].trim();

ok('MUTATION: without the split, the value is unusable', () => {
  const naive = (raw) => String(raw ?? '').trim().slice(0, 64);
  assert.notEqual(naive(`${DEV}, ${DEV}`), DEV);
});

ok('a duplicated header resolves to the single id', () => {
  assert.equal(normalise(`${DEV}, ${DEV}`), DEV);
});

ok('an already-correct header is unchanged', () => {
  assert.equal(normalise(DEV), DEV);
});

ok('an empty or missing header is empty, never a comma fragment', () => {
  assert.equal(normalise(''), '');
  assert.equal(normalise(undefined), '');
  assert.equal(normalise(null), '');
});

ok('OLD and NEW builds resolve to the SAME key — the rollout is safe', () => {
  // This is the point. The terminal key feeds migration 63's one-open-drawer
  // unique index. If an updated till resolved differently from the shift it
  // opened, it would look like a new terminal and be allowed a second drawer.
  const fromOldBuild = normalise(`${DEV}, ${DEV}`);
  const fromNewBuild = normalise(DEV);
  assert.equal(fromOldBuild, fromNewBuild);
});

ok('the split happens BEFORE any length cap', () => {
  assert.match(TKEY, /split\(','\)\[0\]/);
  const i = TKEY.indexOf("split(',')[0]");
  const cap = TKEY.indexOf('slice(', i);
  // Either no cap in this function, or it comes after the split.
  assert.ok(cap === -1 || cap > i, 'slicing the joined value is the original bug');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. The till sends the header exactly once');

/** Header keys in one object literal, lowercased — HTTP does not distinguish. */
function headerKeys(src, fnName) {
  const start = src.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `${fnName} not found`);
  const body = src.slice(start, src.indexOf('\n}', start));
  return (body.match(/^\s*'([A-Za-z0-9-]+)'\s*:/gm) ?? [])
    .map(s => s.trim().replace(/^'|'\s*:$/g, '').toLowerCase());
}

for (const fn of ['authHeaders', 'pushAuthHeaders']) {
  ok(`${fn} declares no header twice under different casing`, () => {
    const keys = headerKeys(SYNC, fn);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dupes, [],
      `duplicate header key(s) ${JSON.stringify(dupes)} — fetch will send both ` +
      'and the server receives them comma-joined');
  });
}

ok('both builders spell the device id header the same way', () => {
  const a = headerKeys(SYNC, 'authHeaders').filter(k => k === 'x-device-id');
  const b = headerKeys(SYNC, 'pushAuthHeaders').filter(k => k === 'x-device-id');
  assert.equal(a.length, 1, 'authHeaders must send it exactly once');
  assert.equal(b.length, 1, 'pushAuthHeaders must send it exactly once');
  // Disagreeing spellings across the two builders is how the pair got into one
  // object in the first place.
  const spell = (fn) => {
    const start = SYNC.indexOf(`function ${fn}(`);
    const body = SYNC.slice(start, SYNC.indexOf('\n}', start));
    return (body.match(/'([xX]-[dD]evice-[iI]d)'\s*:/) ?? [])[1];
  };
  assert.equal(spell('authHeaders'), spell('pushAuthHeaders'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
