// The demo request form's checks (src/lib/demoForm.ts). The server must repeat them; these spare a wasted send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kenyanPhone, emailOk, checkDemoRequest, MIN_FILL_MS } from '../src/lib/demoForm.ts';

const ok = { name: 'Wanjiru', business: 'Mama Lishe Grill', type: 'restaurant', branches: '2', phone: '0717 675 635', email: '', town: 'Nairobi', message: '', website: '' };

test('Kenyan phone numbers in every common spelling', () => {
  for (const p of ['0717 675 635', '0717675635', '+254 717 675 635', '254717675635', '0110-123-456']) assert.ok(kenyanPhone(p), p);
  assert.equal(kenyanPhone('0717 675 635'), '+254717675635');
  for (const p of ['', '12345', '0217675635', '+255717675635', '07176756351']) assert.equal(kenyanPhone(p), null, p);
});

test('the email is optional, but checked when given', () => {
  assert.ok(emailOk(''));
  assert.ok(emailOk('owner@example.co.ke'));
  assert.ok(!emailOk('owner@'));
});

test('a good request passes; the honeypot and a too-fast send do not', () => {
  assert.deepEqual(checkDemoRequest(ok, 0, MIN_FILL_MS + 1), {});
  assert.ok(checkDemoRequest({ ...ok, website: 'x' }, 0, MIN_FILL_MS + 1).form);
  assert.ok(checkDemoRequest(ok, 0, 1000).form);
});

test('each missing or wrong field is named', () => {
  const e = checkDemoRequest({ ...ok, name: '', type: 'hotel', phone: '123', branches: 'two' }, 0, 10000);
  assert.deepEqual(Object.keys(e).sort(), ['branches', 'name', 'phone', 'type']);
});
