// A506 — 1.0.16 pre-deployment audit of the web apps: the new cloud refusals (A494/A495/A502) handled on screen.
//
//   node --no-warnings tests/web-a506.test.mjs
//
// MUTATIONS TO CONFIRM BITE: put the retry's throw back inside the try in POSAuthContext → "a wrong clock PIN keeps the
// cashier signed in" fails; send role_id / override_keys / email on every staff edit → "a staff edit sends only what
// changed" fails; drop device_hint from the branch pick → "the branch pick is the same device" fails; show Confirm on
// every token row → "Confirm only where the cloud allows it" fails; drop the `ref === null` return → "Cancel on Mark
// paid" fails; posError back to the bare `error` → "a permission refusal names the permission" fails.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pos = read('apps/dashboard/src/context/POSAuthContext.tsx');
const api = read('apps/dashboard/src/lib/api.ts');
const staff = read('apps/dashboard/src/pages/settings/StaffTab.tsx');
const login = read('apps/dashboard/src/pages/pos/POSLoginScreen.tsx');
const admin = read('apps/admin/src/AdminPortal.tsx');
const staffRoute = read('apps/server/src/routes/staff.ts');
const { posError } = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/posError.ts')).href);

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

console.log('\nWeb POS / manager portal\n');
ok('a wrong clock PIN keeps the cashier signed in (the cloud answers 401 "Invalid PIN"; the renewed retry\'s refusal is thrown outside the try)', () => {
  assert.match(staffRoute, /res\.status\(401\)\.json\(\{ error: 'Invalid PIN' \}\)/);   // the reason this matters
  assert.match(pos, /retryError = posError\(retryJson, retryRes\.status\);\s*\}\s*\} catch \{\s*\/\/ fall through to clean expiry\s*\}\s*if \(retryError\) throw retryError;/);
  assert.doesNotMatch(pos, /throw new Error\(retryJson\.error/);
});
ok('a refusal keeps the cloud\'s code and status (SELF_APPROVAL, PIN_LOCKED, OWNER_ONLY)', () => {
  const e = posError({ error: 'Someone else approves your own void.', code: 'SELF_APPROVAL' }, 409);
  assert.strictEqual(e.message, 'Someone else approves your own void.');
  assert.strictEqual(e.code, 'SELF_APPROVAL');
  assert.strictEqual(e.status, 409);
  assert.match(pos, /if \(!res\.ok\) throw posError\(json, res\.status\);/);
});
ok('a permission refusal names the permission (not the bare "Forbidden")', () => {
  const e = posError({ error: 'Forbidden', detail: 'Missing permission: menu.promotions' }, 403);
  assert.match(e.message, /permission/);
  assert.match(e.message, /menu\.promotions/);
  assert.strictEqual(posError({ error: 'Forbidden', detail: 'receipt.manage may only write the receipt text' }, 403).message, 'receipt.manage may only write the receipt text');
  assert.strictEqual(posError(null, 500).message, 'Request failed: 500');
  assert.match(api, /if \(!fieldErrors && json\.error === 'Forbidden'\) err\.message = posError\(json, res\.status\)\.message;/);
});
ok('a browser left with only a Supabase session is signed out on SIGN_IN_AGAIN (not left with empty pages)', () => {
  assert.match(api, /if \(errBody\.code === 'SIGN_IN_AGAIN'\) signalSessionExpired\(\);/);
});
ok('the branch pick is the same device (device_hint) and a device refusal shows its screen', () => {
  const pick = login.slice(login.indexOf('async function selectBranch'));
  assert.match(pick, /device_hint: await getDeviceHint\(\)/);
  assert.match(pick, /data\.code === 'DEVICE_REJECTED'\)\s+\{ setStep\('login'\); setDeviceRejected\(true\)/);
  assert.match(pick, /data\.code === 'DEVICE_NOT_REGISTERED'\) \{ setStep\('login'\); setDevicePending\(true\)/);
});

console.log('\nSettings › Staff\n');
ok('a staff edit sends only what changed (role_id, override_keys, e-mail, branches) — OWN_ACCESS / PEER_CREDENTIALS', () => {
  assert.match(staffRoute, /code: 'OWN_ACCESS'/);
  assert.match(staffRoute, /code: 'PEER_CREDENTIALS'/);
  assert.match(staff, /\.\.\.\(emailChanged \? \{ email: email\.trim\(\) \} : \{\}\)/);
  assert.match(staff, /\.\.\.\(roleChanged \? \{ role_id: roleId \} : \{\}\)/);
  assert.match(staff, /\.\.\.\(keysChanged \? \{ override_keys \} : \{\}\)/);
  assert.match(staff, /sameSet\(selectedBranches, editing\.user_branches\?\.map\(b => b\.branch_id\) \?\? \[\]\) \? \{\} : \{ branch_ids: selectedBranches \}/);
  assert.doesNotMatch(staff, /^\s+role_id: roleId,\s*$/m);
});
ok('the helpers compare as sets', () => {
  const src = staff.slice(staff.indexOf('export function sameSet'), staff.indexOf('// ── Staff Modal'));
  const js = src.replace(/: readonly string\[\]/g, '').replace(/: Record<string, boolean> \| null \| undefined/g, '').replace(/\): boolean \{/g, ') {').replace(/export /g, '');
  const { sameSet, sameOverrides } = new Function(`${js}; return { sameSet, sameOverrides };`)();
  assert.ok(sameSet(['a', 'b'], ['b', 'a']));
  assert.ok(!sameSet(['a'], ['a', 'b']));
  assert.ok(!sameSet([], ['a']));
  assert.ok(sameOverrides({}, undefined));
  assert.ok(sameOverrides({ x: true, y: false }, { y: false, x: true }));
  assert.ok(!sameOverrides({ x: true }, { x: false }));
});
ok('an override PIN is offered only to someone who will void or refund (OVERRIDE_PIN_NO_AUTHORITY)', () => {
  assert.match(staffRoute, /OVERRIDE_PIN_NO_AUTHORITY/);
  assert.match(staff, /const mayApprove = effectiveKeys\.has\('\*'\) \|\| effectiveKeys\.has\('sales\.void'\) \|\| effectiveKeys\.has\('sales\.refund'\);/);
  assert.match(staff, /overridePin && mayApprove \? \{ override_pin: overridePin \}/);
  assert.match(staff, /disabled=\{clearOverride \|\| !mayApprove\}/);
});

console.log('\nOne renewal chain, stripped figures, refusals said\n');
ok('the web POS renews ONE token chain (posApi through api.ts refreshSession; a renewed token is never presented again)', () => {
  assert.match(pos, /const refreshData = await refreshSession\(session\.refreshToken\);/);
  assert.doesNotMatch(pos, /fetch\(`\$\{BASE_URL\}\/api\/auth\/refresh`/);
  assert.match(api, /const refreshToken = fromToken \? newestOf\(fromToken\) : stored;/);
  assert.match(api, /if \(data\.refreshToken\) renewedInto\.set\(refreshToken, data\.refreshToken\);/);
  assert.match(api, /async function refreshAccessToken\(\): Promise<string> \{\s*return \(await refreshSession\(\)\)\.accessToken;/);
  assert.match(pos, /window\.addEventListener\('swiftpos:pos-token', onToken\)/);
  assert.match(pos, /d\.renewedFrom && d\.renewedFrom !== cur\.refreshToken/);
});
ok('the renewal chain, run: a token renewed twice is followed to its newest successor', () => {
  const start = api.indexOf('const renewedInto');
  const src = api.slice(start, api.indexOf('\n', api.indexOf('const newestOf')));
  const js = src.replace(/new Map<string, string>\(\)/, 'new Map()').replace(/\(t: string\): string =>/, '(t) =>').replace(/\.get\(x\)!/g, '.get(x)');
  const { renewedInto, newestOf } = new Function(`${js}; return { renewedInto, newestOf };`)();
  renewedInto.set('R0', 'R1'); renewedInto.set('R1', 'R2');
  assert.strictEqual(newestOf('R0'), 'R2');
  assert.strictEqual(newestOf('X'), 'X');
});
ok('a blind count reads "being counted" on the manager\'s transfer picker (quantity null — never "in stock: 0")', () => {
  const r = read('apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx');
  assert.match(r, /stock: r\.quantity === null \|\| r\.quantity === undefined \? null : Number\(r\.quantity\) \|\| 0/);
  assert.match(r, /p\.stock === null \? 'being counted' : `in stock: \$\{p\.stock\}`/);
});
ok('stripped count values read "—", never "KES 0.00"', () => {
  const c = read('apps/dashboard/src/components/StockCounts.tsx');
  assert.match(c, /const cash = \(v: unknown, currency: string\): string => \{ const n = num\(v\); return n === null \? '—' : money\(n, currency\); \};/);
  assert.doesNotMatch(c, /money\(s\.(short|over|net)Value/);
});
ok('History asks for transfers only with inventory.transfer; Expiry offers batch edits only with receive / adjust', () => {
  assert.match(read('apps/dashboard/src/pages/manager/ManagerHistoryTab.tsx'), /hasPermission\('inventory\.transfer'\) \? posApi\.get<TRow\[\]>\('\/api\/stock\/transfers'\)/);
  assert.match(read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), /canEditBatches=\{hasPermission\('inventory\.receive'\) \|\| hasPermission\('inventory\.adjust'\)\}/);
  assert.match(read('apps/dashboard/src/components/Expiry.tsx'), /\{canEditBatches && <button disabled=\{!branchId\} onClick=\{\(\) => setAdding\(true\)\}/);
});
ok('a QR order refusal (429 / unknown item) is shown in the cart, not as "Menu unavailable"', () => {
  const q = read('apps/dashboard/src/pages/QRMenuPage.tsx');
  assert.match(q, /setOrderError\(e\.message \?\? 'Failed to place order/);
  assert.doesNotMatch(q, /setError\(e\.message \?\? 'Failed to place order/);
  assert.match(q, /if \(!res\.ok \|\| data\.error\) throw/);
});
ok('the KDS shows the cloud\'s reason (KDS_TOKEN_REVOKED) and re-pair only for a token problem; a refused move is undone', () => {
  const k = read('apps/dashboard/src/pages/kds/KDSPage.tsx');
  assert.match(k, /setAuthWhy\(state === 'auth' \?/);
  assert.match(k, /authWhy\.code\.startsWith\('KDS_TOKEN'\)\) && <button/);
  assert.match(k, /if \(!r\.ok\) fetchTickets\(branchId!\);/);
});
ok('Promotions and Staff say a refusal (load, switch, delete, deactivate, activate)', () => {
  const pr = read('apps/dashboard/src/pages/PromotionsPage.tsx');
  assert.doesNotMatch(pr, /catch \{ \/\* silent \*\/ \}/);
  assert.match(pr, /data-testid="promotions-error"/);
  assert.match(staff, /catch \(e: any\) \{ setListError\(e\?\.message \?\? 'Could not deactivate'\); \}/);
  assert.match(staff, /data-testid="staff-error"/);
});

console.log('\nAdmin portal\n');
ok('Confirm on a tech token only where the cloud allows it (a super admin, not their own)', () => {
  const n = admin.match(/admin\?\.role === "super_admin" && t\.admin_id !== admin\?\.id/g) ?? [];
  assert.strictEqual(n.length, 2);
  assert.match(admin, /admin_id: admin\?\.id, admin_name: admin\?\.name, branch_name: t\.branch_name \?\? t\.branch/);
});
ok('a new mode switch row has its real id (request_id) — Cancel no longer calls /mode-switch/undefined', () => {
  assert.match(admin, /id: s\.request_id \?\? s\.switch_id \?\? s\.id/);
});
ok('Cancel on Mark paid marks nothing', () => {
  assert.match(admin, /const ref = await askPrompt\("Payment reference \(optional\):"\);\s*if \(ref === null\) return;/);
});
ok('an admin switched off is told so (ADMIN_INACTIVE), and the role is re-read from /auth/me', () => {
  assert.match(admin, /data\?\.code === "ADMIN_INACTIVE"/);
  assert.match(admin, /setError\(expired === "1" \? "Your session expired\. Please sign in again\." : expired\)/);
  assert.match(admin, /req\("GET", "\/auth\/me", undefined\)/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
