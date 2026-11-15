/**
 * stk-query.test.mjs — the STK Push Query recovery (apps/server/src/lib/stkQuery.ts): ask Safaricom the REAL outcome of a
 * pending STK prompt so a lost/late callback doesn't mark a paid customer unpaid. The pure ResultCode→outcome mapper and
 * the request it sends Daraja (with an injected stand-in fetch). The /status wiring is guarded in stk-query-wiring below.
 *
 *   node --no-warnings tests/stk-query.test.mjs   (bundles the lib with esbuild; supabase stubbed so it is hermetic)
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - readStkQueryOutcome mapping a non-zero ResultCode to success  → "a declined query is failed, never success"
 *   - readStkQueryOutcome concluding on an errorCode (processing)   → "still-processing stays pending (recoverable)"
 *   - readStkQueryOutcome concluding failed on an HTTP error        → "a transient HTTP error stays pending"
 *   - queryStkStatus dropping the Password/CheckoutRequestID        → "the query names the checkout + a password"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 300)}`); fail++; } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/server', 'apps/dashboard'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stkq-'));
// Stub the heavy neighbours branchMpesa pulls in at import (a real supabase client needs env) so this stays hermetic.
fs.writeFileSync(path.join(tmp, 'stub-supabase.cjs'), `module.exports = { supabase: {} };`);
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export { readStkQueryOutcome, describeStkFailure, stkTimestamp, queryStkStatus }
    from ${JSON.stringify(path.join(ROOT, 'apps/server/src/lib/stkQuery.ts'))};
`);
await esbuild.build({   // async build — plugins are not allowed in buildSync
  entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'out.cjs'),
  alias: {
    '@zaptill/core': path.join(ROOT, 'packages/core/src'),
  },
  // branchMpesa imports './supabase' (relative); redirect it to the stub so no client is constructed.
  plugins: [{
    name: 'stub-supabase',
    setup(build) {
      build.onResolve({ filter: /\/supabase$/ }, () => ({ path: path.join(tmp, 'stub-supabase.cjs') }));
    },
  }],
  resolveExtensions: ['.ts', '.tsx', '.js', '.json'],
  logLevel: 'silent',
});
const M = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

const run = async () => {
  console.log('\nreadStkQueryOutcome (pure)');
  eq('ResultCode 0 → success', M.readStkQueryOutcome(true, { ResultCode: '0', ResultDesc: 'ok' }), { outcome: 'success' });
  eq('ResultCode "1032" (cancelled) → failed, named', M.readStkQueryOutcome(true, { ResultCode: '1032', ResultDesc: 'Request cancelled by user' }), { outcome: 'failed', reason: 'Cancelled by the customer' });
  eq('ResultCode 1037 (no response) → failed, named', M.readStkQueryOutcome(true, { ResultCode: 1037 }), { outcome: 'failed', reason: 'No response from the customer (timed out)' });
  eq('an unknown finalised code → failed, keeps the ResultDesc', M.readStkQueryOutcome(true, { ResultCode: '4444', ResultDesc: 'Some new error' }), { outcome: 'failed', reason: 'Some new error' });
  ok('a declined query is failed, never success', M.readStkQueryOutcome(true, { ResultCode: '1' }).outcome === 'failed');
  ok('still-processing (errorCode 500.001.1001) stays pending (recoverable)',
    M.readStkQueryOutcome(false, { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }).outcome === 'pending');
  ok('a transient HTTP error (no body) stays pending', M.readStkQueryOutcome(false, {}).outcome === 'pending');
  ok('a 2xx with no ResultCode and no error stays pending', M.readStkQueryOutcome(true, {}).outcome === 'pending');

  console.log('\ndescribeStkFailure');
  eq('1037 named', M.describeStkFailure('1037'), 'No response from the customer (timed out)');
  eq('2001 wrong PIN', M.describeStkFailure('2001'), 'Wrong M-Pesa PIN');
  eq('unknown falls back to the code when no desc', M.describeStkFailure('7777'), 'M-Pesa declined (code 7777)');

  console.log('\nstkTimestamp');
  eq('14-digit YYYYMMDDHHMMSS', M.stkTimestamp(new Date('2026-11-15T09:08:07.000Z')), '20261115090807');

  console.log('\nqueryStkStatus (injected fetch)');
  const CFG = { consumerKey: 'CK', consumerSecret: 'CS', shortcode: '174379', tillNumber: null, passkey: 'PK', type: 'buygoods', environment: 'sandbox', source: 'business' };
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/oauth/v1/generate')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'TOK' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ResultCode: '0', ResultDesc: 'The service request is processed successfully.' }) };
  };
  {
    const out = await M.queryStkStatus(CFG, 'sandbox', 'ws_CO_123', fakeFetch);
    eq('a good query → success', out, { outcome: 'success' });
    const oauth = calls.find(c => c.url.includes('/oauth/'));
    const query = calls.find(c => c.url.includes('/mpesa/stkpushquery/v1/query'));
    ok('it fetches an OAuth token then the query', !!oauth && !!query);
    ok('oauth uses the Basic consumer credentials', oauth.init.headers.Authorization === 'Basic ' + Buffer.from('CK:CS').toString('base64'));
    const body = JSON.parse(query.init.body);
    ok('the query names the checkout + a password + the shortcode + a timestamp',
      body.CheckoutRequestID === 'ws_CO_123' && typeof body.Password === 'string' && body.Password.length > 0 && body.BusinessShortCode === '174379' && /^\d{14}$/.test(body.Timestamp), query.init.body);
    ok('the password is base64(shortcode+passkey+timestamp)', body.Password === Buffer.from(`174379PK${body.Timestamp}`).toString('base64'));
    ok('the query is a Bearer call', query.init.headers.Authorization === 'Bearer TOK');
  }
  {
    const declined = async (url) => String(url).includes('/oauth/')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'T' }) }
      : { ok: true, status: 200, text: async () => JSON.stringify({ ResultCode: '1032', ResultDesc: 'cancelled' }) };
    eq('a cancelled query → failed(reason)', await M.queryStkStatus(CFG, 'sandbox', 'c', declined), { outcome: 'failed', reason: 'Cancelled by the customer' });
  }
  {
    const tokenFail = async () => ({ ok: false, status: 400, text: async () => 'bad creds' });
    ok('an OAuth failure → pending (never concludes)', (await M.queryStkStatus(CFG, 'sandbox', 'c', tokenFail)).outcome === 'pending');
  }
  {
    const boom = async () => { throw new Error('ECONNRESET'); };
    ok('a network throw → pending (the 70 s fallback still ends it)', (await M.queryStkStatus(CFG, 'sandbox', 'c', boom)).outcome === 'pending');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};
run();
