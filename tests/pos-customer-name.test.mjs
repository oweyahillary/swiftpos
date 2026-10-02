/**
 * pos-customer-name.test.mjs — A194 (optional customer name at POS).
 *
 * The POS could only tag an order with a name when a LOYALTY customer was
 * attached; a walk-in (call-ahead / named collection) had nowhere to type one.
 * This adds a free-text name in the Payment modal that feeds the SAME
 * customer_name the create payload already carries, and shows it on the receipt.
 * The server already accepts + stores customer_name, so this is client-only.
 *
 * Source-level; mutation-checkable — drop the `customerName.trim() ||` fallback
 * from the payload or the receipt, or the server's persist, and a named assertion
 * fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modal  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/pos/PaymentModal.tsx'), 'utf8');
const server = fs.readFileSync(path.join(root, 'apps/server/src/routes/orders.ts'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('modal: holds a free-text customer-name state', () => {
  assert.match(modal, /const \[customerName, setCustomerName\] = useState\(''\)/,
    'a walk-in name needs its own state, independent of the loyalty customer');
  assert.match(modal, /value=\{customerName\}[\s\S]*?onChange=\{e => setCustomerName\(e\.target\.value\)\}/,
    'an input must bind to that state');
});

ok('modal: the name flows into the order payload (walk-in OR loyalty)', () => {
  assert.match(modal, /customer_name:\s*\(customerName\.trim\(\) \|\| loyaltyState\?\.customer\.name\)/,
    'buildOrderPayload must prefer the typed name and fall back to the loyalty name');
});

ok('modal: the name shows on the printed/preview receipt', () => {
  assert.match(modal, /customerName=\{customerName\.trim\(\) \|\| loyaltyState\?\.customer\.name\}/,
    'the receipt customerName prop must use the typed name too, not only the loyalty name');
});

ok('server: the create path still persists customer_name (client relies on it)', () => {
  assert.match(server, /customer_name:\s*customer_name\s*\?\?\s*null/,
    'POST /api/orders must store customer_name — pin the producer so the client change is not silent');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
