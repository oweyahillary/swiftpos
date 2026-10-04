/**
 * tenant-signin.test.mjs — A378: a client's own sign-in address (africanfries.<root>), their logo, sign-in locked to them.
 *
 * Owner, 2026-10-02: "is there a way we can customize each client to use their subdomain eg africanfries … to log in we
 * can even add their logo on the sign in page". The shared rule run for real; the cloud's /login decision run from the
 * built server; source assertions on the routes (Express + Supabase) and the screens (React).
 *
 * MUTATIONS TO CONFIRM BITE: isTenantOrigin without the https check → "never http" fails; ownedTenantBusiness returning
 * the account's own business on a 'one' → "never another business it owns" fails; /pos-login without the business filter → its pin fails; /login checking the address
 * after the password → "an unknown address is refused before the password" fails; the admin route without the
 * validation → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const T = await import(pathToFileURL(path.join(ROOT, 'shared/tenantHost.ts')).href);
const R = 'zaptill.co.ke';

// ── The shared rule ───────────────────────────────────────────────────────────
await ok('the address bar: a client\'s address gives its subdomain', () => {
  assert.strictEqual(T.subdomainFromHost('africanfries.zaptill.co.ke', R), 'africanfries');
  assert.strictEqual(T.subdomainFromHost('AfricanFries.ZapTill.co.ke.', R), 'africanfries');
  assert.strictEqual(T.subdomainFromHost('africanfries.zaptill.co.ke:443', R), 'africanfries');
  assert.strictEqual(T.subdomainFromHost('africanfries.zaptill.co.ke', ' .Zaptill.co.ke. '), 'africanfries');
});
await ok('one level only; not the root, not ours (app., www.), not another domain, not when the root is unset', () => {
  assert.strictEqual(T.subdomainFromHost('a.africanfries.zaptill.co.ke', R), null);
  assert.strictEqual(T.subdomainFromHost('zaptill.co.ke', R), null);
  assert.strictEqual(T.subdomainFromHost('app.zaptill.co.ke', R), null);
  assert.strictEqual(T.subdomainFromHost('www.zaptill.co.ke', R), null);
  assert.strictEqual(T.subdomainFromHost('africanfries.evil.com', R), null);
  assert.strictEqual(T.subdomainFromHost('africanfrieszaptill.co.ke', R), null);
  assert.strictEqual(T.subdomainFromHost('swiftpos-dashboard.vercel.app', R), null);
  assert.strictEqual(T.subdomainFromHost('localhost', R), null);
  assert.strictEqual(T.subdomainFromHost('africanfries.zaptill.co.ke', ''), null);
  assert.strictEqual(T.subdomainFromHost('africanfries.zaptill.co.ke', undefined), null);
});
await ok('what may be set: 3–32 lowercase letters, digits, single hyphens inside; ours are reserved; empty clears', () => {
  assert.strictEqual(T.cleanSubdomain(' AfricanFries '), 'africanfries');
  assert.strictEqual(T.cleanSubdomain('african-fries'), 'african-fries');
  assert.strictEqual(T.cleanSubdomain(''), null);
  assert.strictEqual(T.cleanSubdomain(null), null);
  for (const bad of ['ab', 'a'.repeat(33), '-fries', 'fries-', 'af--fries', 'african fries', 'af.fries', 'afríca', 'app', 'admin', 'www', 'mail', 'api', 42]) {
    assert.strictEqual(T.cleanSubdomain(bad), undefined, String(bad));
  }
  assert.match(T.subdomainProblem('admin'), /reserved/);
  assert.match(T.subdomainProblem('ab'), /3 to 32/);
});
await ok('the cloud lets a browser on the root or one level under it call it — https only', () => {
  assert.strictEqual(T.isTenantOrigin('https://africanfries.zaptill.co.ke', R), true);
  assert.strictEqual(T.isTenantOrigin('https://app.zaptill.co.ke', R), true);
  assert.strictEqual(T.isTenantOrigin('https://zaptill.co.ke', R), true);
});
await ok('never http, a deeper name, a look-alike, junk, or when the root is unset', () => {
  assert.strictEqual(T.isTenantOrigin('http://africanfries.zaptill.co.ke', R), false);
  assert.strictEqual(T.isTenantOrigin('https://a.b.zaptill.co.ke', R), false);
  assert.strictEqual(T.isTenantOrigin('https://evilzaptill.co.ke', R), false);
  assert.strictEqual(T.isTenantOrigin('https://zaptill.co.ke.evil.com', R), false);
  assert.strictEqual(T.isTenantOrigin('https://africanfries.zaptill.co.ke/path', R), false);
  assert.strictEqual(T.isTenantOrigin('https://user:pw@africanfries.zaptill.co.ke', R), false);
  assert.strictEqual(T.isTenantOrigin('null', R), false);
  assert.strictEqual(T.isTenantOrigin('https://africanfries.zaptill.co.ke', ''), false);
});

// ── The cloud's /login decision (the built server) ────────────────────────────
const DIST = path.join(ROOT, 'apps/server/dist/lib/tenant.js');
if (fs.existsSync(DIST)) {
  process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
  process.env.JWT_SECRET ??= randomBytes(24).toString('hex');
  const L = createRequire(import.meta.url)(DIST);
  const A = { id: 'biz-african' }, P = { id: 'biz-pizza' };
  await ok('/login on a client\'s address: the account opens that business when it owns it', () => {
    assert.strictEqual(L.ownedTenantBusiness({ kind: 'one', business: A }, A.id), A);
    assert.strictEqual(L.ownedTenantBusiness({ kind: 'many', businesses: [P, A] }, A.id), A);
  });
  await ok('…and never another business it owns, nor none (refused: NOT_THIS_BUSINESS)', () => {
    assert.strictEqual(L.ownedTenantBusiness({ kind: 'one', business: P }, A.id), null);
    assert.strictEqual(L.ownedTenantBusiness({ kind: 'many', businesses: [P] }, A.id), null);
    assert.strictEqual(L.ownedTenantBusiness({ kind: 'none' }, A.id), null);
  });
  await ok('the full address only when the root is configured', () => {
    const before = process.env.TENANT_ROOT_DOMAIN;
    delete process.env.TENANT_ROOT_DOMAIN;
    assert.strictEqual(L.signInAddress('africanfries'), null);
    process.env.TENANT_ROOT_DOMAIN = 'ZapTill.co.ke';
    assert.strictEqual(L.signInAddress('africanfries'), 'https://africanfries.zaptill.co.ke');
    assert.strictEqual(L.signInAddress(null), null);
    if (before === undefined) delete process.env.TENANT_ROOT_DOMAIN; else process.env.TENANT_ROOT_DOMAIN = before;
  });
} else {
  console.log('SKIP  /login decision (apps/server/dist not built)');
}

// ── The wiring (source) ───────────────────────────────────────────────────────
const auth = read('apps/server/src/routes/auth.ts');
const loginSrc = auth.slice(auth.indexOf("router.post('/login'"), auth.indexOf("router.post('/desktop-login'"));
const posSrc = auth.slice(auth.indexOf("router.post('/pos-login'"), auth.indexOf("router.post('/verify-pin'"));
await ok('/login: an unknown address is refused before the password is checked; the account must own the business', () => {
  assert.ok(loginSrc.indexOf('const tenant = await findTenant(subdomain);') > 0);
  assert.ok(loginSrc.indexOf('const tenant = await findTenant(subdomain);') < loginSrc.indexOf('signInWithPassword'));
  assert.match(loginSrc, /code: 'UNKNOWN_SUBDOMAIN'/);
  assert.match(loginSrc, /tenant\.kind === 'found' \? tenant\.tenant\.id : \(business_id \?\? null\)\);/);
  assert.match(loginSrc, /if \(owned\.kind !== 'error' && !ownedTenantBusiness\(owned, tenant\.tenant\.id\)\) \{/);
  assert.match(loginSrc, /code: 'NOT_THIS_BUSINESS'/);
});
await ok('/pos-login: on a client\'s address only that business\'s people match (same answer as a wrong email)', () => {
  assert.match(posSrc, /const tenant = await findTenant\(subdomain\);/);
  assert.match(posSrc, /if \(tenant\.kind === 'found'\) \{\s*matches = matches\.filter\(\(u: any\) => u\.business_id === tenant\.tenant\.id\);\s*\}/);
  assert.ok(posSrc.indexOf('matches = matches.filter((u: any) => u.business_id === tenant.tenant.id)') < posSrc.indexOf('const user = matches[0];'));
});
await ok('the public lookup gives the name, logo and accent only — and is mounted', () => {
  const r = read('apps/server/src/routes/tenant.ts');
  assert.match(r, /res\.json\(\{\s*name:\s+found\.tenant\.name,\s*logo:\s+[^\n]+,\s*accent: [^\n]+,\s*\}\);/);
  assert.match(read('apps/server/src/routes/index.ts'), /router\.use\('\/tenant',\s+tenantRoutes\);/);
});
await ok('CORS lets a client\'s address in (the shared rule, TENANT_ROOT_DOMAIN)', () => {
  assert.match(read('apps/server/src/index.ts'), /if \(isTenantOrigin\(origin, process\.env\.TENANT_ROOT_DOMAIN\)\) return callback\(null, true\);/);
});
await ok('only the admin sets it: validated, a taken address refused; the owner\'s settings cannot', () => {
  const a = read('apps/server/src/routes/admin.ts');
  assert.match(a, /const sub = cleanSubdomain\(req\.body\.subdomain\);\s*if \(sub === undefined\) \{/);
  assert.match(a, /if \(\(error as any\)\.code === '23505' && updates\.subdomain\) \{/);
  assert.match(a, /sign_in_address:\s+signInAddress\(\(biz as any\)\.subdomain\),/);
  assert.ok(!/'subdomain'/.test(read('apps/server/src/routes/business.ts').match(/const EDITABLE = \[[^\]]*\]/)[0]));
});
await ok('the sign-in pages send the address and show the client (or "not set up")', () => {
  const lp = read('apps/dashboard/src/pages/LoginPage.tsx');
  assert.match(lp, /\{ email, password, \.\.\.\(businessId \? \{ business_id: businessId \} : \{\}\), \.\.\.tenantSignInFields\(\),/);   // A391: + the code
  assert.match(lp, /if \(tenant\.status === 'unknown'\) return <UnknownTenantAddress subdomain=\{tenant\.subdomain\} \/>;/);
  assert.match(lp, /<TenantBrand tenant=\{tenant\.tenant\} \/>/);
  const ps = read('apps/dashboard/src/pages/pos/POSLoginScreen.tsx');
  assert.strictEqual((ps.match(/\.\.\.tenantSignInFields\(\),/g) || []).length, 2, 'both pos-login calls send the address');
  assert.match(ps, /if \(tenant\.status === 'unknown'\) return <UnknownTenantAddress subdomain=\{tenant\.subdomain\} \/>;/);
  assert.match(read('apps/dashboard/src/lib/tenant.ts'), /subdomainFromHost\(window\.location\.hostname, import\.meta\.env\.VITE_TENANT_ROOT_DOMAIN\)/);
});
await ok('the admin portal sets it (checked first) and shows the full address', () => {
  const p = read('apps/admin/src/AdminPortal.tsx');
  assert.match(p, /const clean = cleanSubdomain\(raw\);\s*if \(clean === undefined\) \{/);
  assert.match(p, /await req\("PATCH", `\/clients\/\$\{client\.id\}`, \{ subdomain: clean \}\);/);
  assert.match(p, /data-testid="signin-address"/);
});
await ok('migration 114 and the schema index carry businesses.subdomain', () => {
  assert.match(read('migrations/114_business_subdomain.sql'), /ADD COLUMN IF NOT EXISTS subdomain text;/);
  assert.strictEqual(JSON.parse(read('scripts/schema-index.json')).businesses.subdomain, '"text"');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
