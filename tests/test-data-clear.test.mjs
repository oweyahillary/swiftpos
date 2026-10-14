/**
 * test-data-clear.test.mjs — A396: clearing a client's test data between two times — the admin routes and the portal
 * card. The database function itself runs for real in scripts/test-migration-122.mjs (every migration, PGlite).
 *
 * Owner, 2026-10-04: "the purge i should be able to select the date it starts and time (which the system should give by
 * default) and the date and time testing stopped so that i should not purge a real sale".
 *
 * MUTATIONS TO CONFIRM BITE: the clear without requireSuperAdmin → "only a super admin" fails; the name check dropped →
 * "the client's name typed" fails; the preview not a dry run → its pin fails; the default start not the set-up time → its
 * pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const a = read('apps/server/src/routes/admin.ts');
const card = read('apps/admin/src/TestDataCard.tsx');
const mig = read('migrations/122_test_data_purge.sql');

console.log('\nClear test data\n');
ok('the window defaults to when the client was set up → now; the admin can change both', () => {
  assert.match(a, /const from = createdAt \? new Date\(createdAt\) : new Date\(now\.getTime\(\) - 7 \* 86_400_000\);/);
  assert.match(a, /const \{ data: biz \} = await supabase\.from\('businesses'\)\.select\('id, name, created_at'\)/);
  assert.match(card, /type="datetime-local" value=\{from\}/); assert.match(card, /type="datetime-local" value=\{to\}/);
});
ok('the preview is a dry run; the clear is super admin only, the name typed, audited', () => {
  assert.match(a, /router\.get\('\/clients\/:id\/test-data', requireAdmin,[\s\S]*?p_dry_run: true,/);
  assert.match(a, /router\.post\('\/clients\/:id\/test-data\/clear', requireAdmin, requireSuperAdmin,/);
  assert.match(a, /String\(b\.confirm_name \?\? ''\)\.trim\(\)\.toLowerCase\(\) !== String\(biz\.name\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(a, /action: 'test_data_cleared'/);
  assert.match(a, /if \(!r\.ok\) \{ res\.status\(409\)/);
});
ok('a till that has not synced since testing stopped is named (it may hold unsent test sales)', () => {
  assert.match(a, /\.filter\(\(t\) => !t\.last_sync_at \|\| t\.last_sync_at < to\)/);
  assert.match(card, /data-testid="tills-behind"/);
});
ok('the card shows the first sale after the window (it stays) and refuses with the reasons', () => {
  assert.match(card, /First sale after the window: <b>\{c\.next_sale_after/);
  assert.match(card, /data-testid="test-data-problems"/);
  assert.match(card, /const canClear = isSuper && data && !stale && problems\.length === 0 && !nothing && confirm\.trim\(\)\.toLowerCase\(\) === data\.business\.name\.trim\(\)\.toLowerCase\(\);/);
});
// ── A482: "Also delete the whole menu" ──
const mig132 = read('migrations/132_test_data_menu.sql');
ok('A482: the box is unticked by default; ticked, a red warning says what goes and that it cannot be undone', () => {
  assert.match(card, /const \[menu, setMenu\] = useState\(false\);/);
  assert.match(card, /<input type="checkbox" checked=\{menu\} onChange=\{\(e\) => setMenu\(e\.target\.checked\)\} data-testid="test-menu" \/> Also delete the whole menu<\/label>/);
  assert.match(card, /\{menu && \(\s*<div style=\{\{ fontSize: 12, color: C\.danger,[^}]*\}\} data-testid="test-menu-warning">/);
  assert.ok(card.includes("Every product, category, variant / choice group, extra, combo, recipe, branch price, offer and the menu's stock levels are deleted. The till menus empty on their next sync. This cannot be undone."));
});
ok('A482: the preview asks with menu, shows the menu counts, and a preview for the other setting cannot be cleared', () => {
  assert.match(card, /new URLSearchParams\(\{ stock, customers: String\(customers\), menu: String\(menu\) \}\)/);
  assert.match(card, /data-testid="test-menu-counts"/);
  assert.match(card, /const stale = !!data && menuShown !== menu;/);
  assert.match(card, /const canClear = isSuper && data && !stale && problems\.length === 0/);
  assert.match(card, /stock_mode: stock, delete_customers: customers, menu, confirm_name: confirm,/);
});
ok('A482: the route — menu=true previews and clears through purge_test_menu; super admin, the name typed; menu validated and audited', () => {
  assert.match(a, /const menu = req\.query\.menu === 'true';[\s\S]*?supabase\.rpc\(menu \? 'purge_test_menu' : 'purge_test_data', \{[\s\S]*?p_dry_run: true,/);
  assert.match(a, /if \(b\.menu !== undefined && typeof b\.menu !== 'boolean'\) \{ res\.status\(400\)/);
  assert.match(a, /router\.post\('\/clients\/:id\/test-data\/clear', requireAdmin, requireSuperAdmin,[\s\S]*?const menu = b\.menu === true;[\s\S]*?String\(b\.confirm_name[\s\S]*?supabase\.rpc\(menu \? 'purge_test_menu' : 'purge_test_data'/);
  assert.match(a, /delete_customers: b\.delete_customers === true, menu, counts: r\.counts/);
  assert.match(a, /historyOf\('from_at, to_at, stock_mode, counts, done_by, created_at, menu'\)/);
});
ok('A482: the function — one transaction with the window\'s clear, refused while a real sale outside the window uses the menu, recorded', () => {
  assert.match(mig132, /v_res := public\.purge_test_data\(p_business, p_from, p_to, p_stock_mode, p_delete_customers,\s*p_dry_run OR coalesce\(array_length\(v_problems, 1\), 0\) > 0/);
  assert.match(mig132, /real sale\(s\) outside the window use the menu — clear those first or untick ''Also delete the whole menu''/);
  assert.match(mig132, /UPDATE public\.test_data_purges SET menu = true, counts = v_counts/);
  assert.doesNotMatch(mig132, /ON DELETE CASCADE|DROP CONSTRAINT/, 'no foreign key is changed');
  for (const t of ['users', 'roles', 'branches', 'user_devices', 'business_settings', 'suppliers', 'ingredients', 'print_stations', 'pumps']) {
    assert.doesNotMatch(mig132, new RegExp(`DELETE FROM public\\.${t}\\b`), t);
  }
});

ok('what the business IS is never touched by the function', () => {
  for (const t of ['products', 'categories', 'users', 'roles', 'branches', 'user_devices', 'business_settings', 'recipes', 'suppliers', 'ingredients']) {
    assert.doesNotMatch(mig, new RegExp(`DELETE FROM public\\.${t}\\b`), t);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
