/**
 * mailer-sendgrid.test.mjs — A352 (2026-09-28): email through SendGrid.
 *
 * Owner: "on emails i want to use sendgrid for emails" → "resend is the primary, if it fails sendgrid kicks in or smtp,
 * the two works as backup". No email has been delivered since A50/A54: Render filters outbound SMTP and RESEND_API_KEY
 * was never set. Order now: Resend → SendGrid (over HTTPS, never SMTP) → SMTP; each only when the one before is unset
 * or fails.
 *
 *   node tests/mailer-sendgrid.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED apps/server/dist/lib/mailer.js with a fake `fetch` standing in for api.sendgrid.com (and
 * api.resend.com for the fallback). Each scenario loads the module afresh with its own environment, because the
 * mailer reads its keys at load, as in production.
 *
 * MUTATIONS TO CONFIRM BITE: send `{ email: opts.to }` unsplit → "several recipients" fails; drop the `throw` when
 * every provider refused → "a refusal is a failure" fails; move the SendGrid block before Resend → "Resend first"
 * fails; drop `Bearer ` → "the key goes only in the Authorization header" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
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
const logs = [];
const quiet = () => {
  for (const k of ['info', 'warn', 'error']) console[k] = (...a) => logs.push(a.map(String).join(' '));
};
const loud = { info: console.info, warn: console.warn, error: console.error };
const restore = () => { Object.assign(console, loud); globalThis.fetch = realFetch; };

/** Load the compiled mailer fresh with `env`, answering fetch with `answer(url, init)`; returns { m, calls }. */
function load(env, answer) {
  for (const k of MAIL_ENV) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(MAILER)];
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    calls.push({ url: u, init, body: init.body ? JSON.parse(String(init.body)) : null });
    return answer(u, init);
  };
  logs.length = 0;
  quiet();
  const m = require(MAILER);
  return { m, calls };
}
const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const KEY = `SG.${randomBytes(12).toString('hex')}`;
const FROM = 'SwiftPOS <noreply@swiftpos.example>';

await ok('SendGrid alone (no Resend key): one HTTPS call to api.sendgrid.com, provider "sendgrid"', async () => {
  const { m, calls } = load({ SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM }, () => json(202));
  const r = await m.sendEmailChecked({ to: 'owner@shop.example', subject: 'Hi', html: '<p>x</p>' });
  restore();
  assert.deepEqual(r, { ok: true, provider: 'sendgrid' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(calls[0].init.method, 'POST');
});

await ok('the message SendGrid receives: from name + address, subject, the HTML body', async () => {
  const { m, calls } = load({ SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM }, () => json(202));
  await m.sendEmail({ to: 'owner@shop.example', subject: 'Daily summary', html: '<b>KES 1,000</b>' });
  restore();
  assert.deepEqual(calls[0].body, {
    personalizations: [{ to: [{ email: 'owner@shop.example' }] }],
    from: { name: 'SwiftPOS', email: 'noreply@swiftpos.example' },
    subject: 'Daily summary',
    content: [{ type: 'text/html', value: '<b>KES 1,000</b>' }],
  });
});

await ok('several recipients (the daily summary joins them "a, b") → one entry each, duplicates dropped', async () => {
  const { m, calls } = load({ SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM }, () => json(202));
  await m.sendEmail({ to: 'a@shop.example, b@shop.example;a@shop.example , ', subject: 's', html: 'h' });
  restore();
  assert.deepEqual(calls[0].body.personalizations[0].to, [{ email: 'a@shop.example' }, { email: 'b@shop.example' }]);
});

await ok('the key goes only in the Authorization header — never in the body, never in the logs', async () => {
  const { m, calls } = load({ SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM }, () => json(403, { errors: [{ message: 'nope' }] }));
  await m.reportMailReadiness();
  await m.sendEmailChecked({ to: 'o@shop.example', subject: 's', html: 'h' });
  restore();
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(calls[0].body).includes(KEY));
  assert.ok(logs.length > 0 && logs.every((l) => !l.includes(KEY)), logs.join('\n'));
  assert.ok(logs.some((l) => /SendGrid configured \(backup, standing in for Resend\)/.test(l)), logs.join('\n'));
});

await ok('a refusal is reported with SendGrid\'s own words (unverified sender)', async () => {
  const msg = 'The from address does not match a verified Sender Identity.';
  const { m } = load({ SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM }, () => json(403, { errors: [{ message: msg }] }));
  const r = await m.sendEmailChecked({ to: 'o@shop.example', subject: 's', html: 'h' });
  restore();
  assert.equal(r.ok, false);
  assert.equal(r.provider, 'sendgrid');
  assert.match(r.error, /HTTP 403/);
  assert.ok(r.error.includes(msg), r.error);
});

await ok('a refusal is a FAILURE for the nightly jobs: sendEmail throws (their per-business catch logs it)', async () => {
  const { m } = load({ SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM }, () => json(401, { errors: [{ message: 'bad key' }] }));
  await assert.rejects(() => m.sendEmail({ to: 'o@shop.example', subject: 'Daily', html: 'h' }), /Email "Daily" to o@shop\.example was not sent — SendGrid: HTTP 401 — bad key/);
  restore();
});

await ok('no network: the error comes back, nothing thrown from sendEmailChecked', async () => {
  const { m } = load({ SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM }, () => { throw new TypeError('fetch failed'); });
  const r = await m.sendEmailChecked({ to: 'o@shop.example', subject: 's', html: 'h' });
  restore();
  assert.deepEqual([r.ok, r.provider], [false, 'sendgrid']);
  assert.match(r.error, /fetch failed/);
});

const RE = () => `re_${randomBytes(8).toString('hex')}`;

await ok('Resend is the PRIMARY: when it delivers, SendGrid is never called', async () => {
  const { m, calls } = load({ RESEND_API_KEY: RE(), SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM },
    (u) => u.includes('api.resend.com') ? json(200, { id: 'r1' }) : json(202));
  const r = await m.sendEmailChecked({ to: 'o@shop.example', subject: 's', html: 'h' });
  await m.sendEmail({ to: 'o@shop.example', subject: 's', html: 'h' });
  await m.reportMailReadiness();
  restore();
  assert.deepEqual(r, { ok: true, provider: 'resend' });
  assert.ok(calls.length === 2 && calls.every((c) => c.url.includes('api.resend.com')), calls.map((c) => c.url).join(', '));
  assert.ok(logs.some((l) => /Resend configured \(primary\)/.test(l)) && logs.some((l) => /SendGrid configured \(backup\)/.test(l)), logs.join('\n'));
});

await ok('Resend refuses → SendGrid kicks in and delivers (Resend first, then SendGrid)', async () => {
  const { m, calls } = load({ RESEND_API_KEY: RE(), SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM },
    (u) => u.includes('api.resend.com') ? json(403, { statusCode: 403, name: 'validation_error', message: 'domain not verified' }) : json(202));
  const r = await m.sendEmailChecked({ to: 'o@shop.example', subject: 's', html: 'h' });
  restore();
  assert.deepEqual(r, { ok: true, provider: 'sendgrid' });
  const order = calls.map((c) => (c.url.includes('api.resend.com') ? 'resend' : c.url.includes('api.sendgrid.com') ? 'sendgrid' : c.url));
  assert.deepEqual(order, ['resend', 'sendgrid']);
});

await ok('both refuse and no SMTP: a failure naming each provider\'s reason; the jobs\' sendEmail throws', async () => {
  const { m } = load({ RESEND_API_KEY: RE(), SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: FROM },
    (u) => u.includes('api.resend.com') ? json(403, { statusCode: 403, name: 'validation_error', message: 'domain not verified' })
      : json(403, { errors: [{ message: 'sender not verified' }] }));
  const r = await m.sendEmailChecked({ to: 'o@shop.example', subject: 's', html: 'h' });
  await assert.rejects(() => m.sendEmail({ to: 'o@shop.example', subject: 'Daily', html: 'h' }),
    /Email "Daily" to o@shop\.example was not sent — Resend: .*domain not verified.*; SendGrid: HTTP 403 — sender not verified/);
  restore();
  assert.equal(r.ok, false);
  assert.match(r.error, /Resend: .*domain not verified.*; SendGrid: HTTP 403 — sender not verified — and no SMTP fallback is configured\./);
});

await ok('without SENDGRID_API_KEY nothing is sent to SendGrid, and the message names it', async () => {
  const { m, calls } = load({ NOTIFY_FROM_EMAIL: FROM }, () => json(202));
  const r = await m.sendEmailChecked({ to: 'o@shop.example', subject: 's', html: 'h' });
  await m.reportMailReadiness();
  restore();
  assert.equal(calls.length, 0);
  assert.deepEqual([r.ok, r.provider], [false, 'none']);
  assert.match(r.error, /SENDGRID_API_KEY/);
  assert.ok(logs.some((l) => /NO EMAIL PROVIDER CONFIGURED[\s\S]*SENDGRID_API_KEY/.test(l)));
});

await ok('a free-mail sender is warned about at boot (DMARC sends it to spam)', async () => {
  load({ SENDGRID_API_KEY: KEY, NOTIFY_FROM_EMAIL: 'Shop <someone@gmail.com>' }, () => json(202));
  restore();
  assert.ok(logs.some((l) => /free-mail sender through SendGrid/.test(l)), logs.join('\n'));
});

await ok('parseFrom: "Name <addr>", quoted names and a bare address', async () => {
  const { m } = load({}, () => json(202));
  restore();
  assert.deepEqual(m.parseFrom('SwiftPOS <noreply@x.co.ke>'), { name: 'SwiftPOS', email: 'noreply@x.co.ke' });
  assert.deepEqual(m.parseFrom('"B Foods, Nairobi" <hi@b.co.ke>'), { name: 'B Foods, Nairobi', email: 'hi@b.co.ke' });
  assert.deepEqual(m.parseFrom('<hi@b.co.ke>'), { email: 'hi@b.co.ke' });
  assert.deepEqual(m.parseFrom(' hi@b.co.ke '), { email: 'hi@b.co.ke' });
});

for (const k of MAIL_ENV) delete process.env[k];
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
