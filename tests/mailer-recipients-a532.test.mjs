/**
 * mailer-recipients-a532.test.mjs — A532 (Render log, 2026-10-19): "Resend error … Invalid `to` field" every 15 min for
 * Pollo's not-syncing alert. The alerts and summaries join their recipients ("owner@x, manager@y"); resend 6.33 refuses
 * the joined string. Every send now hands Resend a list, drops entries that are not addresses, and refuses an empty list.
 *
 *   node tests/mailer-recipients-a532.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the compiled lib/mailer.js against a stand-in Resend API (the SDK's own fetch is answered here) and reads what it
 * would have sent.
 *
 * MUTATIONS TO CONFIRM BITE: `to: opts.to` back in sendEmail → "a joined list reaches Resend as a list" fails; the
 * ADDRESS filter removed → "a phone number in the list is dropped" fails; the empty-list throw removed → "nothing valid
 * → no send" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAILER = path.join(ROOT, 'apps/server/dist/lib/mailer.js');
if (!fs.existsSync(MAILER)) {
  console.log('\nCannot load apps/server/dist/lib/mailer.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
const require = createRequire(MAILER);
let pass = 0, fail = 0;
const ok = async (name, f) => {
  try { await f(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

const MAIL_ENV = ['SENDGRID_API_KEY', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'NOTIFY_FROM_EMAIL'];
const realFetch = globalThis.fetch;
const loud = { info: console.info, warn: console.warn, error: console.error, log: console.log };
const logs = [];
const quiet = () => { for (const k of ['info', 'warn', 'error']) console[k] = (...a) => logs.push(a.map(String).join(' ')); };
const restore = () => { Object.assign(console, loud); globalThis.fetch = realFetch; };

function load() {
  for (const k of MAIL_ENV) delete process.env[k];
  process.env.RESEND_API_KEY = 're_test_only';
  process.env.NOTIFY_FROM_EMAIL = 'ZapTill <reports@example.com>';
  delete require.cache[require.resolve(MAILER)];
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (/resend/.test(u)) {
      sent.push(body);
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
  logs.length = 0;
  quiet();
  return { m: require(MAILER), sent };
}

console.log('\nA532 — mail recipients\n');

await ok('mailRecipients: a joined list → one entry per address, blanks and duplicates dropped', async () => {
  const { m } = load(); restore();
  assert.deepEqual(m.mailRecipients('owner@x.co.ke, manager@y.com;; owner@x.co.ke ,'), ['owner@x.co.ke', 'manager@y.com']);
  assert.deepEqual(m.mailRecipients('Jane <jane@x.com>'), ['Jane <jane@x.com>']);
});
await ok('a phone number or a word in the list is dropped (and logged); the rest still go', async () => {
  const { m } = load();
  const r = m.mailRecipients('owner@x.co.ke, 0712345678, manager');
  restore();
  assert.deepEqual(r, ['owner@x.co.ke']);
  assert.ok(logs.some((l) => /dropped 2 recipient/.test(l)), logs.join(' | '));
});
await ok('nothing valid → no send (it throws, so the caller logs one clear line)', async () => {
  const { m } = load(); restore();
  assert.throws(() => m.mailRecipients(''), /no valid recipient/);
  assert.throws(() => m.mailRecipients('0712345678'), /no valid recipient/);
});
await ok('a joined list reaches Resend as a list (sendEmail — the alerts and summaries)', async () => {
  const { m, sent } = load();
  await m.sendEmail({ to: 'owner@x.co.ke, manager@y.com', subject: 'T1 is not syncing', html: '<p>x</p>' });
  restore();
  assert.equal(sent.length, 1, 'one Resend call');
  assert.deepEqual(sent[0].to, ['owner@x.co.ke', 'manager@y.com']);
});
await ok('…and sendEmailChecked (the owner test email) the same', async () => {
  const { m, sent } = load();
  const r = await m.sendEmailChecked({ to: 'owner@x.co.ke', subject: 'test', html: '<p>x</p>' });
  restore();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(sent[0].to, ['owner@x.co.ke']);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
