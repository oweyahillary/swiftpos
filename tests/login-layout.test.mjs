/**
 * login-layout.test.mjs — A424 (owner, 2026-10-10: "use the client's branding colour; owner, let it remain as is, email
 * and password — what I meant is the content overflows, can we find a better way, something classy and presentable").
 *
 *   node tests/login-layout.test.mjs
 *
 * RUNS apps/dashboard/src/lib/loginBrand.ts (the client's colour, kept readable on the dark page), then pins the layout
 * that keeps every step on screen (React is not run here; the page was checked in a real browser at 1366×600, 1280×800
 * and 375×667 — with nine businesses to choose from, nothing was cut off).
 *
 * MUTATIONS TO CONFIRM BITE: loginBrand not lifting a dark colour → "a navy or black brand still shows" fails; the form
 * side centred with items-center (not auto margins) → "never cut off" fails; the button back on ZapTill teal → "the
 * button is the client's colour" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.LOGIN_LAYOUT_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, LOGIN_LAYOUT_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

// The two files run as they are, from a temp copy (their import has no .ts extension, which the type stripper needs).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a424-'));
fs.writeFileSync(path.join(tmp, 'contrast.ts'), read('apps/dashboard/src/lib/contrast.ts'));
fs.writeFileSync(path.join(tmp, 'loginBrand.ts'), read('apps/dashboard/src/lib/loginBrand.ts').replace("from './contrast'", "from './contrast.ts'"));
const L = await import(pathToFileURL(path.join(tmp, 'loginBrand.ts')).href);
const C = await import(pathToFileURL(path.join(tmp, 'contrast.ts')).href);

console.log('\nThe client\'s colour');
ok('the client\'s colour as given, when it already shows on the dark page', () => {
  const b = L.loginBrand('#E11D48');
  assert.equal(b.raw, '#e11d48'); assert.equal(b.accent, '#e11d48');
});
ok('a navy or black brand still shows: lifted until ≥ 3:1 on the page', () => {
  for (const c of ['#1e3a8a', '#000000', '#111827', '#3b0764']) {
    const b = L.loginBrand(c);
    assert.ok(C.contrastRatio(b.accent, L.LOGIN_BG) >= 3, `${c} → ${b.accent}`);
    assert.equal(b.raw, c);   // the panel's wash keeps the true colour
  }
});
ok('the button\'s text reads on it (black or white, the better)', () => {
  for (const c of ['#e11d48', '#fde047', '#1e3a8a', '#0d9488']) {
    const b = L.loginBrand(c);
    assert.ok(C.contrastRatio(b.accent, b.text) >= 3, `${c}: ${b.text} on ${b.accent}`);
  }
});
ok('no client (the main address) or a bad colour: ZapTill\'s teal', () => {
  assert.equal(L.loginBrand(null).raw, C.DEFAULT_ACCENT);
  assert.equal(L.loginBrand('red').raw, C.DEFAULT_ACCENT);
});

console.log('\nThe layout');
const lp = read('apps/dashboard/src/pages/LoginPage.tsx');
ok('never cut off: the form side scrolls on its own and is centred with auto margins', () => {
  assert.ok(lp.includes('<main className="flex-1 min-h-0 overflow-y-auto flex flex-col px-5 py-8 sm:px-10">'));
  assert.ok(lp.includes('<div className="w-full max-w-sm m-auto">'));
  assert.ok(!/flex items-center justify-center px-4">\n\n      \{\/\* Background grid/.test(lp), 'the old centred column is gone');
});
ok('a wide screen splits: the brand panel in the client\'s colour, beside the form', () => {
  assert.ok(lp.includes('className="min-h-screen bg-[#080c14] lg:h-screen flex flex-col lg:flex-row" style={brandVars}'));
  assert.ok(lp.includes('<aside className="hidden lg:flex'));
  assert.ok(lp.includes('${brand.raw}66'));
});
ok('the button and the focus ring are the client\'s colour', () => {
  assert.ok(lp.includes("const brand = loginBrand(tenant.status === 'found' ? tenant.tenant.accent : null);"));
  assert.ok(lp.includes("style={{ background: 'var(--brand)', color: 'var(--brand-text)' }}"));
  assert.ok(lp.includes('focus:border-[color:var(--brand)] focus:ring-1 focus:ring-[color:var(--brand)]'));
});
ok('the same fields: email and password, forgot password, the code step, the business choice', () => {
  for (const s of ['type="email"', "type={showPw ? 'text' : 'password'}", 'data-testid="forgot-link"', '<OtpCodeStep', 'Choose a business']) assert.ok(lp.includes(s), s);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
