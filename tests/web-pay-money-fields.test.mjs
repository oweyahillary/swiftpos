/**
 * web-pay-money-fields.test.mjs — the web till's /pay body carries the money
 * fields the server needs to reconcile the legs.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * An order sent to the kitchen first is paid later through
 * POST /api/orders/:id/pay. PaymentModal posted only `{ payments }`, but the
 * legs carried grandTotal = (subtotal − capped discount) + tip. The route
 * recomputes amountDue = subtotal − capDiscount(discount_amount) + tip_amount
 * and, with neither field sent, compared the legs against the bare subtotal:
 * any tip or any discount on a dine-in sale was a 400 PAYMENT_MISMATCH.
 * The new-order path (buildOrderPayload) always sent all three and was fine.
 *
 * tip-reconciliation.test.mjs models the /pay guard ASSUMING tip_amount
 * arrives. This file pins that the web client actually sends it.
 *
 * Source assertions: PaymentModal is a React component and the route needs a
 * live Supabase client, so the wiring is read rather than mounted.
 *
 *   node tests/web-pay-money-fields.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// Blank out comments (keeping offsets) so a field named only in a comment
// cannot satisfy an assertion.
const read = rel => readFileSync(resolve(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

const modal  = read('apps/dashboard/src/pages/pos/PaymentModal.tsx');
const orders = read('apps/server/src/routes/orders.ts');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

/** Body of `function <name>(...) { return { ... }; }` — the object literal text. */
function returnedObject(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `function ${name} not found`);
  const open = src.indexOf('return {', start);
  assert.notStrictEqual(open, -1, `${name} does not return an object literal`);
  let depth = 0;
  for (let i = open + 'return '.length; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Map of top-level `key: value` / shorthand `key` entries in an object literal. */
function fields(obj) {
  const inner = obj.slice(obj.indexOf('{') + 1, obj.lastIndexOf('}'));
  const out = new Map();
  let depth = 0, cur = '';
  for (const ch of inner) {
    if ('{[('.includes(ch)) depth++;
    if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { push(cur); cur = ''; } else cur += ch;
  }
  push(cur);
  function push(s) {
    s = s.trim(); if (!s) return;
    const m = s.match(/^(\w+)\s*(?::\s*([\s\S]*))?$/);
    if (m) out.set(m[1], (m[2] ?? m[1]).replace(/\s+/g, ' ').trim());
  }
  return out;
}

const MONEY = ['tip_amount', 'discount_amount', 'discount_id'];

console.log('\n1. the /pay body carries the money fields, valued as buildOrderPayload values them');
let payBody = new Map(), orderBody = new Map();
ok('PaymentModal has a dedicated /pay body builder', () => {
  payBody   = fields(returnedObject(modal, 'buildPayPayload'));
  orderBody = fields(returnedObject(modal, 'buildOrderPayload'));
});
ok('the /pay body carries the legs', () => assert.ok(payBody.has('payments')));
for (const k of MONEY) {
  ok(`the /pay body carries ${k}`, () =>
    assert.ok(payBody.has(k), `buildPayPayload sends only: ${[...payBody.keys()].join(', ')}`));
  ok(`${k} has the same value as on the new-order path`, () =>
    assert.strictEqual(payBody.get(k), orderBody.get(k),
      'The legs are grandTotal on both paths; the fields that produce it must agree.'));
}
ok('discount_amount is the CAPPED discount, not the raw one', () =>
  assert.strictEqual(payBody.get('discount_amount'), 'cappedDiscount'));

console.log('\n2. every /pay call site uses that body');
{
  const sites = [...modal.matchAll(/existingOrderId\s*\?\s*([^:]+?)\s*:\s*buildOrderPayload\(payments\)/g)]
    .map(m => m[1].trim());
  ok('both charge paths (single-method and split) choose a /pay body', () =>
    assert.strictEqual(sites.length, 2, `found ${sites.length} call site(s)`));
  ok('each one is buildPayPayload(payments)', () =>
    assert.deepStrictEqual(sites, ['buildPayPayload(payments)', 'buildPayPayload(payments)'],
      `call sites send: ${JSON.stringify(sites)}`));
  ok('no bare { payments } body is posted to /pay', () =>
    assert.ok(!/existingOrderId\s*\?\s*\{\s*payments\s*\}/.test(modal)));
}

console.log('\n3. the route reads exactly those names');
{
  const start = orders.indexOf("router.post('/:id/pay'");
  const head  = orders.slice(start, orders.indexOf('= req.body', start));
  for (const k of MONEY) {
    ok(`/pay destructures ${k} from req.body`, () =>
      assert.ok(new RegExp(`\\b${k}\\b`).test(head), 'a renamed field would silently default to 0'));
  }
}

console.log('\n4. composed: the client body fed to the /pay guard');
{
  const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const cap = (d, sub, pct = 10) => round2(Math.min(Math.max(0, d), sub * pct / 100, sub));
  // Server (orders.ts /pay): amountDue = subtotal − capDiscount(discount_amount) + tip.
  const payGuard = (subtotal, body) => {
    const due = round2(round2(subtotal - cap(Number(body.discount_amount ?? 0), subtotal))
                       + Math.max(0, Number(body.tip_amount ?? 0)));
    const legs = body.payments.reduce((s, l) => s + l.amount, 0);
    return Math.abs(legs - due) <= 0.01;
  };
  // Client: build the body using the field set read from buildPayPayload.
  const clientBody = (subtotal, rawDiscount, tip) => {
    const cappedDiscount = cap(rawDiscount, subtotal);
    const grandTotal = round2(subtotal - cappedDiscount) + tip;
    const vals = { payments: [{ amount: grandTotal }], discount_amount: cappedDiscount, tip_amount: tip, discount_id: null };
    return Object.fromEntries([...payBody.keys()].filter(k => k in vals).map(k => [k, vals[k]]));
  };
  for (const [d, t] of [[0, 0], [0, 50], [80, 0], [250, 90]]) {
    ok(`discount ${d}, tip ${t} on a 1000 sent-to-kitchen order is accepted`, () =>
      assert.ok(payGuard(1000, clientBody(1000, d, t))));
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
