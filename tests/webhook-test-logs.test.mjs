/**
 * webhook-test-logs.test.mjs — A146.
 *
 * The webhook Deliveries log was empty for test pings: POST /:id/test fetched the
 * endpoint but never wrote a webhook_deliveries row (real events DO, via deliverOne).
 * This guards that the test route now logs the ping — both on success and failure —
 * so the observability UI reflects it. Source-level (mirrors the repo's guard tests).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'apps/server/src/routes/webhooks.ts'), 'utf8');

// Isolate the test-ping handler body.
const start = src.indexOf("router.post('/:id/test'");
assert.ok(start !== -1, 'test route not found');
const body = src.slice(start, src.indexOf('export default'));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

ok('test ping inserts a webhook_deliveries row', () => {
  const inserts = body.match(/from\('webhook_deliveries'\)\s*\.insert/g) || [];
  assert.ok(inserts.length >= 2, `expected a delivery insert on both success and failure paths (found ${inserts.length})`);
  assert.match(body, /event:\s*'ping'/, "the logged row must be event:'ping'");
  assert.match(body, /response_status:\s*response\.status/, 'success path must record the response status');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
