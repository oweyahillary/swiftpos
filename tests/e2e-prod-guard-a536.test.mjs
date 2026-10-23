// A536 — the nightly end-to-end suites refuse PRODUCTION, loudly.
//
//   node --no-warnings tests/e2e-prod-guard-a536.test.mjs
//
// The suites create staff, products and real paid orders. e2e/lib/prod-guard.mjs is the one guard every entry point
// calls (tests/runner.mjs, both Playwright configs, e2e/seed/seed-staff-api.mjs, .github/workflows/nightly-e2e.yml).
//
//   G  addresses: production refused (api/app/admin.zaptill.co.ke, a client's own address, the production Render and
//      Vercel hosts, E2E_EXTRA_PROD_HOSTS, a typo), dev passes (the dev Render API, dev.zaptill.co.ke, localhost)
//   H  /health: production hides env → refused; env=production → refused; env=development → passes; a sleeping
//      service is waited for
//   C  the command line exits 3 on production, 0 on dev
//   W  the wiring: every entry point calls the guard; the workflow runs it first and never names a production host
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-20):
//   - prodReason without the *.zaptill.co.ke rule          → G "a client's own address" fails
//   - assertHealthNotProduction accepting a missing env    → H "production hides env" fails
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = await import(new URL('../e2e/lib/prod-guard.mjs', import.meta.url).href);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
const noEnv = {};

console.log('G  addresses');
for (const u of [
  'https://api.zaptill.co.ke', 'https://app.zaptill.co.ke/login', 'https://admin.zaptill.co.ke', 'https://zaptill.co.ke',
  'https://africanfries.zaptill.co.ke', 'https://devcafe.zaptill.co.ke', 'https://API.ZAPTILL.CO.KE.',
  'https://swiftpos-prod-mype.onrender.com', 'https://swiftpos-server.onrender.com',
  'https://swiftpos-dashboard.vercel.app', 'https://swiftpos-admin-eta.vercel.app', 'not a url',
]) {
  await t(`refused: ${u}`, () => assert.ok(G.prodReason(u, noEnv), 'should be production'));
}
for (const u of [
  'https://swiftpos-20c2.onrender.com', 'https://dev.zaptill.co.ke', 'https://dev-api.zaptill.co.ke',
  'https://app.dev.zaptill.co.ke', 'https://staging.zaptill.co.ke', 'http://localhost:4000', 'http://127.0.0.1:5173',
  'https://swiftpos-three.vercel.app',
]) {
  await t(`passes: ${u}`, () => assert.strictEqual(G.prodReason(u, noEnv), null));
}
await t('E2E_EXTRA_PROD_HOSTS is refused', () =>
  assert.ok(G.prodReason('https://my-prod.example.com', { E2E_EXTRA_PROD_HOSTS: 'x.y, my-prod.example.com' })));
await t('assertNotProduction throws with the code and names the variable', () => {
  assert.throws(() => G.assertNotProduction({ E2E_API_URL: 'https://swiftpos-20c2.onrender.com', E2E_WEB_URL: 'https://app.zaptill.co.ke' }, noEnv),
    (e) => e.code === 'E2E_PROD_GUARD' && /E2E_WEB_URL=https:\/\/app\.zaptill\.co\.ke/.test(e.message) && !/E2E_API_URL=/.test(e.message));
});
await t('assertNotProduction skips empty addresses', () =>
  G.assertNotProduction({ E2E_API_URL: 'http://localhost:4000', E2E_WEB_URL: '', E2E_ADMIN_URL: undefined }, noEnv));
await t('the test browser cannot resolve production hosts', () => {
  const [arg] = G.chromiumBlockProdArgs(['https://dev.zaptill.co.ke'], noEnv);
  assert.ok(arg.startsWith('--host-resolver-rules='));
  for (const h of ['api.zaptill.co.ke', '*.zaptill.co.ke', 'swiftpos-prod-mype.onrender.com']) assert.ok(arg.includes(`MAP ${h} ~NOTFOUND`), h);
  assert.ok(arg.includes('EXCLUDE dev.zaptill.co.ke'));
  assert.ok(!G.chromiumBlockProdArgs(['https://swiftpos-three.vercel.app'], noEnv)[0].includes('EXCLUDE'));
});

console.log('H  /health');
const fakeFetch = (bodies) => { let i = 0; return async () => {
  const b = bodies[Math.min(i++, bodies.length - 1)];
  if (b instanceof Error) throw b;
  return { ok: b.ok ?? true, status: b.http ?? 200, text: async () => (typeof b.body === 'string' ? b.body : JSON.stringify(b.body)) };
}; };
const quiet = () => {};
await t('production hides env → refused', () => assert.rejects(
  G.assertHealthNotProduction('https://swiftpos-20c2.onrender.com', { waitS: 0, log: quiet, fetchImpl: fakeFetch([{ body: { status: 'ok', db: 'up' } }]) }),
  (e) => e.code === 'E2E_PROD_GUARD'));
await t('env=production → refused', () => assert.rejects(
  G.assertHealthNotProduction('http://localhost:4000', { waitS: 0, log: quiet, fetchImpl: fakeFetch([{ body: { status: 'ok', env: 'production' } }]) }),
  (e) => e.code === 'E2E_PROD_GUARD'));
await t('a production address is refused before any request', async () => {
  let called = false;
  await assert.rejects(G.assertHealthNotProduction('https://api.zaptill.co.ke', { waitS: 0, log: quiet, fetchImpl: async () => { called = true; } }),
    (e) => e.code === 'E2E_PROD_GUARD');
  assert.strictEqual(called, false);
});
await t('env=development → passes', async () => {
  const b = await G.assertHealthNotProduction('http://localhost:4000', { waitS: 0, log: quiet, fetchImpl: fakeFetch([{ body: { status: 'ok', env: 'development' } }]) });
  assert.strictEqual(b.env, 'development');
});
await t('no answer in time → an ordinary error (not the guard)', () => assert.rejects(
  G.assertHealthNotProduction('http://localhost:4000', { waitS: 0, log: quiet, fetchImpl: fakeFetch([new Error('ECONNREFUSED')]) }),
  (e) => e.code !== 'E2E_PROD_GUARD' && /did not answer/.test(e.message)));

console.log('C  command line');
const guard = path.join(ROOT, 'e2e', 'lib', 'prod-guard.mjs');
const run = (env, args = []) => spawnSync(process.execPath, [guard, ...args], {
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8' });
await t('production web address → exit 3', () => {
  const r = run({ E2E_API_URL: 'https://swiftpos-20c2.onrender.com', E2E_WEB_URL: 'https://app.zaptill.co.ke' });
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /PRODUCTION GUARD/);
});
await t('production API → exit 3', () => assert.strictEqual(run({ E2E_API_URL: 'https://api.zaptill.co.ke' }).status, 3));
await t('--check production → exit 3', () => assert.strictEqual(run({}, ['--check', 'https://admin.zaptill.co.ke']).status, 3));
await t('dev addresses → exit 0', () => {
  const r = run({ E2E_API_URL: 'https://swiftpos-20c2.onrender.com', E2E_WEB_URL: 'https://dev.zaptill.co.ke', E2E_ADMIN_URL: 'http://localhost:5174' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

console.log('W  wiring');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
await t('runner, both Playwright configs and the staff seed call the guard', () => {
  assert.match(read('tests/runner.mjs'), /assertNotProduction\(/);
  assert.match(read('tests/runner.mjs'), /assertHealthNotProduction\(/);
  for (const c of ['e2e/playwright.config.ts', 'e2e/playwright.seed.config.ts']) {
    const s = read(c);
    assert.match(s, /assertNotProduction\(targetsFromEnv\(\)\)/, c);
    assert.match(s, /chromiumBlockProdArgs\(/, c);
  }
  assert.match(read('e2e/seed/seed-staff-api.mjs'), /assertNotProduction\(/);
});
await t('the workflow runs the guard before anything else and names no production host', () => {
  const w = read('.github/workflows/nightly-e2e.yml');
  const steps = w.slice(w.indexOf('steps:'));
  const guardAt = steps.indexOf('node e2e/lib/prod-guard.mjs --health');
  assert.ok(guardAt > 0);
  for (const later of ['tests/runner.mjs', 'npm ci', 'seed-staff-api.mjs', 'npx playwright test']) assert.ok(steps.indexOf(later) > guardAt, later);
  const code = w.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  for (const h of G.PROD_HOSTS) assert.ok(!code.includes(h), `workflow names ${h}`);
  assert.ok(!/password\s*:\s*['"][^$]/i.test(code), 'no literal password');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
