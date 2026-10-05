/**
 * wastage.test.mjs — A399: the wastage log — reasons, value, the period summary (lib/wastage.ts, run for real), and pins
 * on the routes and the screens.
 *
 * Owner, 2026-10-05: "i will work with your pic" — spoiled, expired or dropped items, each with a reason, and what it cost.
 *
 * MUTATIONS TO CONFIRM BITE: wastageSummary counting a void entry → "a void entry does not count" fails; the held check
 * removed from the record route → its pin fails; void allowed to inventory.waste → "voiding is the owner's" fails; a
 * made-to-order product moving stock → "value only" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const W = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/wastage.ts')).href);

console.log('\nThe rules\n');
await ok('reasons as people pick them; "Other" needs a note; refs WST-0001 …', () => {
  assert.equal(W.cleanReason(' Expired '), 'expired'); assert.equal(W.cleanReason('kitchen_mistake'), 'kitchen_mistake');
  assert.equal(W.cleanReason('stolen'), null); assert.equal(W.cleanReason(''), null);
  assert.deepEqual(W.WASTE_REASONS.map((r) => r.key), ['expired', 'spoiled', 'damaged', 'kitchen_mistake', 'returned', 'staff_meal', 'other']);
  assert.match(W.noteProblem('other', '  '), /Say what happened/); assert.equal(W.noteProblem('other', 'rat got in'), null); assert.equal(W.noteProblem('expired', ''), null);
  assert.equal(W.wastageRef(0), 'WST-0001'); assert.equal(W.wastageRef(41), 'WST-0042');
  assert.equal(W.entryValue(3, 45.5), 136.5); assert.equal(W.entryValue(2, null), 0);
});
await ok('the period: total, by reason, the most costly items; a void entry does not count', () => {
  const e = (name, reason, quantity, value, extra = {}) => ({ name, item_kind: 'product', product_id: name, ingredient_id: null, quantity, value, reason, created_at: '2026-10-05T10:00:00Z', ...extra });
  const s = W.wastageSummary([
    e('Milk', 'expired', 2, 240), e('Milk', 'spoiled', 1, 120), e('Burger', 'kitchen_mistake', 1, 180),
    e('Coke', 'damaged', 3, 150), e('Coke', 'damaged', 10, 500, { voided_at: '2026-10-05T11:00:00Z' }),
  ]);
  assert.equal(s.total, 690); assert.equal(s.entries, 4);
  assert.deepEqual(s.byReason.map((r) => [r.reason, r.value, r.entries]), [['expired', 240, 1], ['kitchen_mistake', 180, 1], ['damaged', 150, 1], ['spoiled', 120, 1]]);
  assert.equal(s.byReason[1].label, 'Kitchen mistake');
  assert.deepEqual(s.byItem.map((i) => [i.name, i.quantity, i.value]), [['Milk', 3, 360], ['Burger', 1, 180], ['Coke', 3, 150]]);
});

console.log('\nThe cloud and the screens\n');
const r = read('apps/server/src/routes/wastage.ts');
await ok('recording is the manager tier\'s (inventory.waste); voiding — stock back — is the owner\'s (inventory.adjust)', () => {
  assert.match(r, /router\.get\('\/', requireAnyPermission\('inventory\.waste', 'inventory\.adjust'\)/);
  assert.match(r, /router\.get\('\/items', requireAnyPermission\('inventory\.waste', 'inventory\.adjust'\)/);
  assert.match(r, /router\.post\('\/', requireAnyPermission\('inventory\.waste', 'inventory\.adjust'\)/);
  assert.match(r, /router\.post\('\/:id\/void', requirePermission\('inventory\.adjust'\)/);
  assert.match(read('apps/server/src/routes/index.ts'), /router\.use\('\/wastage',\s+wastageRoutes\);/);
  assert.match(read('apps/server/src/lib/permissionCatalogue.ts'), /key: 'inventory\.waste'/);
  assert.ok(!/'inventory\.waste'/.test(read('apps/server/src/lib/defaultRolePermissions.ts')), 'not in MANAGER_DENY — a new manager role gets it');
  assert.match(r, /if \(!assertBranchAccess\(req, branchId\)\) \{ res\.status\(403\)\.json\(\{ error: 'You can only record wastage at your own branch\.' \}\)/);
});
await ok('a stocked item: never more than the branch holds, and the stock leaves naming the entry; made to order: value only', () => {
  assert.match(r, /const moves = p\.track_stock === true;\n\s+if \(moves\) \{/);
  assert.match(r, /if \(qty > held \+ 0\.004\) \{ res\.status\(409\)\.json\(\{ error: `\$\{p\.name\}: only \$\{held\} at this branch\.`, code: 'MORE_THAN_HELD' \}\)/);
  assert.match(r, /if \(!l\.moves\) continue;/);
  assert.equal((r.match(/reference_type: 'wastage', reference_id: entryId/g) ?? []).length, 2);
  assert.match(r, /movement_type: 'wastage',/);   // ingredient movements: the type the baseline already allows
  assert.match(r, /if \(moved\.length\) await supabase\.from\('wastage_entries'\)\.update\(\{ stock_moved: true \}\)\.in\('id', moved\);/);
});
await ok('a void: claimed once (only one wins), the stock goes back only if it left, the entry stays', () => {
  assert.match(r, /\.eq\('id', e\.id\)\.is\('voided_at', null\)\.select\('id'\);/);
  assert.match(r, /if \(e\.stock_moved\) \{/);
  assert.match(r, /code: 'REASON_REQUIRED'/);
  assert.doesNotMatch(r, /from\('wastage_entries'\)\.delete\(\)/);
});
await ok('the screens: Stock › Wastage for the owner, Manager › Wastage (inventory.waste); clear test data counts it', () => {
  assert.match(read('apps/dashboard/src/App.tsx'), /<Route path="stock\/wastage"\s+element=\{<WastagePage \/>\} \/>/);
  assert.match(read('apps/dashboard/src/components/DashboardLayout.tsx'), /\{ to: '\/dashboard\/stock\/wastage',\s+label: 'Wastage'/);
  const m = read('apps/dashboard/src/pages/manager/ManagerDashboard.tsx');
  assert.match(m, /key: 'wastage',.*permission: 'inventory\.waste'/);
  assert.match(m, /case 'wastage':\n\s+return <Wastage client=\{posApi\} branchId=\{session\.branchId\}/);
  const c = read('apps/dashboard/src/components/Wastage.tsx');
  assert.match(c, /client\.get<Item\[\]>\(`\/api\/wastage\/items\?branch_id=\$\{branchId\}`\)/);
  assert.match(c, /report\.can_void && <button onClick=\{\(\) => voidEntry\(e\)\}/);
  assert.match(read('apps/admin/src/TestDataCard.tsx'), /\["wastage", "Wastage"\]/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
