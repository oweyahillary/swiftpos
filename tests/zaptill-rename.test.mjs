/**
 * zaptill-rename.test.mjs — 0.6.36 (A386): the product is ZapTill in everything people see; what live tills and
 * integrations depend on keeps its old name.
 *
 * Owner, 2026-10-03: "let us do the ZapTill rename". The danger is the other half: the till's Windows identity
 * (productName/appId) decides its data folder (%APPDATA%\SwiftPOS — database, sign-in, backups) and its update file
 * names; renaming it would start every till empty. These pins fail the moment someone renames that by accident.
 *
 * MUTATIONS TO CONFIRM BITE: productName → "ZapTill" in package.json → "the till keeps its data folder" fails; receipt
 * credit back to SwiftPOS → its pin fails; drop 'zaptill' from the reserved list → "zaptill is reserved" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const T = await import(pathToFileURL(path.join(ROOT, 'shared/tenantHost.ts')).href);

await ok('kept: the till keeps its data folder, install identity and update file names', () => {
  const pkg = JSON.parse(read('apps/desktop/package.json'));
  assert.strictEqual(pkg.productName, 'SwiftPOS');
  const eb = read('apps/desktop/electron-builder.config.js');
  assert.match(eb, /const name = dev \? 'SwiftPOS Dev' : 'SwiftPOS';/);
  assert.match(eb, /appId: dev \? 'com\.swiftpos\.desktop\.dev' : 'com\.swiftpos\.desktop'/);
  assert.match(read('apps/desktop/src/main/localDb.ts'), /'swiftpos\.db'/);
});
await ok('kept: webhook headers, print-server exe and task names, branch-server firewall rule', () => {
  assert.match(read('apps/server/src/lib/webhooks.ts'), /'X-SwiftPOS-Event'/);
  assert.match(read('apps/print-server/go/install-startup.bat'), /set "TASK=SwiftPOS Print Bridge"/);
  assert.match(read('apps/desktop/build/installer.nsh'), /name="SwiftPOS Branch Server"/);
});
await ok('renamed: the till (PIN logo, title, receipt credit, update banner, Help)', () => {
  const pin = read('apps/desktop/src/renderer/pages/PinPage.tsx');
  assert.match(pin, /alt="ZapTill"/);
  assert.match(decodeURIComponent(pin.match(/const SWIFTPOS_LOGO = "([^"]+)"/)[1]), /ZapTill App Badge/);
  assert.match(read('apps/desktop/index.html'), /<title>ZapTill<\/title>/);
  assert.match(read('apps/desktop/src/main/ipcHandlers.ts'), /footerCredit:\s+'Powered by ZapTill'/);
  assert.match(read('apps/desktop/src/renderer/pages/UpdateBanner.tsx'), /Downloading ZapTill/);
  assert.match(read('shared/printing/src/shiftReport.ts'), /'Powered by ZapTill'/);
  assert.match(read('apps/dashboard/src/lib/escposRenderer.js'), /Powered by ZapTill/);
});
await ok('renamed: the web, the admin portal and the cloud\'s emails and messages', () => {
  assert.match(read('apps/dashboard/index.html'), /<title>ZapTill — Dashboard<\/title>/);
  assert.match(read('apps/dashboard/src/pages/LoginPage.tsx'), /font-black text-sm">Z<\/div>/);
  assert.match(read('apps/dashboard/src/lib/appFlavor.ts'), /prod: \{ label: 'Z', title: 'ZapTill'/);
  assert.match(read('apps/admin/index.html'), /<title>ZapTill Admin<\/title>/);
  assert.match(read('apps/server/src/lib/mailer.ts'), /'ZapTill <noreply@zaptill\.co\.ke>'/);
  assert.match(read('apps/server/src/jobs/dailySummary.ts'), /Sent by ZapTill/);
  assert.match(read('shared/support.ts'), /DEFAULT_SUPPORT_NAME = 'ZapTill support'/);
});
await ok('no "SwiftPOS" left in what a person reads on the web sign-in, POS sign-in, receipts or emails', () => {
  for (const f of ['apps/dashboard/src/pages/LoginPage.tsx', 'apps/dashboard/src/pages/pos/POSLoginScreen.tsx',
    'apps/dashboard/src/pages/pos/ReceiptView.tsx', 'apps/desktop/src/renderer/components/ReceiptView.tsx',
    'apps/server/src/jobs/lowStockChecker.ts', 'apps/server/src/routes/auth.ts']) {
    const visible = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/storeSwiftPOSToken/.test(l));
    assert.ok(!visible.some((l) => l.includes('SwiftPOS')), `${f}: ${visible.find((l) => l.includes('SwiftPOS'))?.trim()}`);
  }
});
await ok('zaptill is reserved as a client address; the address is suggested from the business name', () => {
  assert.match(T.subdomainProblem('zaptill'), /reserved for ZapTill/);
  assert.strictEqual(T.suggestSubdomain('African Fries'), 'africanfries');
  assert.strictEqual(T.suggestSubdomain("Mama Oliech's Café"), 'mamaoliechscafe');
  assert.strictEqual(T.suggestSubdomain('ZapTill'), '');
  assert.strictEqual(T.suggestSubdomain('A&B'), '');
  assert.strictEqual(T.suggestSubdomain('x'.repeat(50)).length, 32);
  assert.match(read('apps/admin/src/AdminPortal.tsx'), /setSubDraft\(d\.subdomain \|\| suggestSubdomain\(d\.name\)\)/);
});
await ok('an address no business uses offers the main sign-in', () => {
  const t = read('apps/dashboard/src/components/TenantBrand.tsx');
  assert.match(t, /Go to ZapTill sign-in/);
  assert.match(t, /`https:\/\/app\.\$\{root\}\/login`/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
