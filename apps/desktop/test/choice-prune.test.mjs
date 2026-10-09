// A425 — the till drops the menu choices the cloud no longer has.
// Owner, 2026-10-09: "why does this menu keep duplicating its variants? when i upload it clients cant sell" — the pizza
// menu (one Size group per pizza: Medium, Large) uploaded three times left the till with three required "Size" groups
// and Medium / Large three times over, because the till's pull only ever added and updated choices.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/choice-prune.test.mjs
//
// Runs the REAL compiled dist/main/choicePrune.js against SQLite tables created exactly as localDb.ts creates them, with
// the pull's own upsert SQL, through three uploads of the pizza menu as the cloud performs them (A389: same group kept,
// its options replaced with new rows; an older upload's copy of the group removed).
//
// MUTATIONS TO CONFIRM BITE:
//   - remove the pruneChoices calls from syncEngine's pull       → "the pull replaces …" pins fail
//   - push every product into variantScope even when its fetch failed → "a failed fetch keeps …" pin fails
//   - pruneChoices skipping the per-option check                → "after three uploads … Medium and Large once" fails
//   - pruneChoices without the orphan-option sweep              → "options of a group that is gone" fails
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { pruneChoices, VARIANT_TABLES, MODIFIER_TABLES } = require(path.join(here, '..', 'dist', 'main', 'choicePrune.js'));
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

let db, driver;
try { const Database = require('better-sqlite3'); db = new Database(':memory:'); driver = 'better-sqlite3'; }
catch { const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(':memory:'); driver = 'node:sqlite (stand-in)'; }
console.log(`driver: ${driver}`);

// The four tables exactly as localDb.ts creates them.
const schema = src('main/localDb.ts');
for (const t of ['variant_groups', 'variant_options', 'modifier_groups', 'modifier_options']) {
  const m = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\s*\\);`));
  if (!m) { console.error(`no CREATE TABLE for ${t} in localDb.ts`); process.exit(1); }
  db.exec(m[0]);
}
// The pull's own upserts (syncEngine.ts).
const upsertVG = db.prepare(`INSERT INTO variant_groups (id, product_id, name, required, sort_order)
  VALUES (@id, @product_id, @name, @required, @sort_order) ON CONFLICT(id) DO UPDATE SET name=excluded.name, required=excluded.required`);
const upsertVO = db.prepare(`INSERT INTO variant_options (id, variant_group_id, name, price_adjustment, sort_order)
  VALUES (@id, @variant_group_id, @name, @price_adjustment, @sort_order) ON CONFLICT(id) DO UPDATE SET name=excluded.name, price_adjustment=excluded.price_adjustment`);

// ── the cloud, as the menu upload leaves it ──
let n = 0;
const id = (p) => `${p}-${++n}`;
const cloud = new Map();   // product_id → [{ id, name, options: [{ id, name, price }] }]
const upload = (pid, large) => {
  const groups = cloud.get(pid) ?? [];
  const keep = groups[0] ?? { id: id('g'), name: 'Size', options: [] };
  keep.options = [{ id: id('o'), name: 'Medium', price: 0 }, { id: id('o'), name: 'Large', price: large }];   // replaced wholesale
  cloud.set(pid, [keep]);   // copies of the group an older upload left are removed (A389)
};
const fetchGroups = (pid) => (cloud.get(pid) ?? []).map((g, i) => ({
  id: g.id, product_id: pid, name: g.name, required: true, sort_order: i,
  variant_options: g.options.map((o, j) => ({ id: o.id, variant_group_id: g.id, name: o.name, price_adjustment: o.price, sort_order: j })),
}));
// ── one till pull: the products with variants are fetched; `failed` ones are not ──
const pull = (pids, { failed = [], prune = true } = {}) => {
  const groups = [], options = [], scope = [];
  for (const pid of pids) {
    if (failed.includes(pid)) continue;
    scope.push(pid);
    for (const g of fetchGroups(pid)) { groups.push(g); options.push(...g.variant_options); }
  }
  for (const g of groups) upsertVG.run({ id: g.id, product_id: g.product_id, name: g.name, required: 1, sort_order: g.sort_order });
  for (const o of options) upsertVO.run(o);
  return prune ? pruneChoices(db, VARIANT_TABLES, scope, groups, options) : null;
};
const tillView = (pid) => db.prepare(`SELECT id, name FROM variant_groups WHERE product_id=?`).all(pid)
  .map((g) => ({ name: g.name, options: db.prepare(`SELECT name FROM variant_options WHERE variant_group_id=? ORDER BY sort_order, name`).all(g.id).map((o) => o.name) }));

// Before A425 — the bug, reproduced: three uploads, no pruning.
console.log('\nThe bug (no pruning)\n');
// a pre-A389 upload had left a second Size group on the cloud; then three uploads
cloud.set('margherita', [{ id: id('g'), name: 'Size', options: [] }, { id: id('g'), name: 'Size', options: [] }]);
cloud.get('margherita')[1].options = [{ id: id('o'), name: 'Medium', price: 0 }, { id: id('o'), name: 'Large', price: 200 }];
pull(['margherita'], { prune: false });
for (let i = 0; i < 3; i++) { upload('margherita', 200); pull(['margherita'], { prune: false }); }
const bug = tillView('margherita');
const medium = bug.flatMap((g) => g.options).filter((o) => o === 'Medium').length;
ok('without pruning the till holds two required "Size" groups and Medium several times', bug.length === 2 && medium >= 4, JSON.stringify(bug));

// After A425 — the same till's next pull heals it.
console.log('\nThe pull replaces a product\'s choices\n');
const healed = pull(['margherita']);
const view = tillView('margherita');
ok('after three uploads the till has ONE "Size" group with Medium and Large once — the pizza can be rung',
  view.length === 1 && JSON.stringify(view[0]) === JSON.stringify({ name: 'Size', options: ['Medium', 'Large'] }), JSON.stringify(view));
ok('and it says what it removed', healed.groups === 1 && healed.options >= 6, JSON.stringify(healed));
upload('margherita', 250); pull(['margherita']);
ok('every later upload stays one group of two', JSON.stringify(tillView('margherita')) === JSON.stringify([{ name: 'Size', options: ['Medium', 'Large'] }]));
ok('the price is the latest upload\'s', db.prepare(`SELECT price_adjustment AS p FROM variant_options WHERE name='Large'`).get().p === 250);

console.log('\nWhat it never touches\n');
upload('pepperoni', 250); pull(['margherita', 'pepperoni']);
const before = JSON.stringify(tillView('pepperoni'));
upload('pepperoni', 300);
pull(['margherita', 'pepperoni'], { failed: ['pepperoni'] });
ok('a failed fetch keeps that product\'s choices as they were (a network blink never strips a menu)', JSON.stringify(tillView('pepperoni')) === before);
pull(['margherita', 'pepperoni']);
ok('…and the next good pull brings the new ones', db.prepare(`SELECT COUNT(*) AS c FROM variant_options o JOIN variant_groups g ON g.id=o.variant_group_id WHERE g.product_id='pepperoni'`).get().c === 2);
db.prepare(`INSERT INTO variant_groups (id, product_id, name, required, sort_order) VALUES ('gx', 'not-pulled', 'Size', 1, 0)`).run();
db.prepare(`INSERT INTO variant_options (id, variant_group_id, name, price_adjustment, sort_order) VALUES ('ox', 'gx', 'Big', 0, 0)`).run();
pull(['margherita']);
ok('a product the pull did not cover is left alone', tillView('not-pulled').length === 1);

console.log('\nLeftovers\n');
db.prepare(`INSERT INTO variant_options (id, variant_group_id, name, price_adjustment, sort_order) VALUES ('orphan', 'gone', 'X', 0, 0)`).run();
pull(['margherita']);
ok('options of a group that is gone are removed', !db.prepare(`SELECT 1 FROM variant_options WHERE id='orphan'`).get());
cloud.set('chips', []);   // the owner removed Chips' choices: the product now has none
db.prepare(`INSERT INTO variant_groups (id, product_id, name, required, sort_order) VALUES ('gc', 'chips', 'Size', 1, 0)`).run();
pruneChoices(db, VARIANT_TABLES, ['chips'], [], []);
ok('a product in scope with no choices upstream has none on the till', tillView('chips').length === 0);
db.prepare(`INSERT INTO modifier_groups (id, product_id, name, min_select, max_select, sort_order) VALUES ('m1', 'burger', 'Extras', 0, 3, 0), ('m2', 'burger', 'Extras', 0, 3, 0)`).run();
db.prepare(`INSERT INTO modifier_options (id, modifier_group_id, name, price, sort_order) VALUES ('mo1', 'm1', 'Cheese', 50, 0), ('mo2', 'm2', 'Cheese', 50, 0)`).run();
pruneChoices(db, MODIFIER_TABLES, ['burger'], [{ id: 'm1' }], [{ id: 'mo1' }]);
ok('add-ons (modifiers) are replaced the same way', db.prepare(`SELECT COUNT(*) AS c FROM modifier_groups`).get().c === 1
  && db.prepare(`SELECT COUNT(*) AS c FROM modifier_options`).get().c === 1);

console.log('\nThe pull calls it\n');
const se = src('main/syncEngine.ts');
const tx = se.slice(se.indexOf('// Write everything in a single transaction'), se.indexOf('// Stock levels — remote wins'));
ok('the pull replaces variants and add-ons inside its one transaction, after the upserts',
  /for \(const o of modifierOptions\) upsertMO\.run\(o\);[\s\S]*pruneChoices\(db, VARIANT_TABLES, variantScope, variantGroups, variantOptions\);\s*\n\s*const mp = pruneChoices\(db, MODIFIER_TABLES, modifierScope, modifierGroups, modifierOptions\);/.test(tx));
ok('a failed fetch keeps that product out of scope (only a 2xx adds it)',
  /if \(vRes\.ok\) \{\s*\n\s*const groups = await vRes\.json\(\);\s*\n\s*variantScope\.push\(String\(p\.id\)\);/.test(se)
  && /if \(mRes\.ok\) \{\s*\n\s*const groups = await mRes\.json\(\);\s*\n\s*modifierScope\.push\(String\(p\.id\)\);/.test(se)
  && /variantScope = products\.filter\(\(p: any\) => !p\.has_variants\)/.test(se));
ok('the branch server\'s snapshot covers every product, so a peer heals too', /variantScope = products\.map\(\(p: any\) => String\(p\.id\)\);\s*\n\s*modifierScope = variantScope;/.test(se));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
