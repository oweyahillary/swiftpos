/**
 * logo-and-stocktake.test.mjs — A232 + A233 source guards (rule 24), mutation-checkable.
 * A232: documents render a business logo (logo_url) — engine + type + settings + PATCH whitelist.
 * A233: the owner Inventory page prints a stock-take count sheet with a blank Counted column.
 * A394 (2026-10-04): the sheet is BLIND — no system figure (owner: "Yes the count should be blind").
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pd  = fs.readFileSync(path.join(root, 'apps/dashboard/src/lib/printDocument.ts'), 'utf8');
const biz = fs.readFileSync(path.join(root, 'apps/server/src/routes/business.ts'), 'utf8');
const bp  = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/settings/BusinessProfileTab.tsx'), 'utf8');
const ty  = fs.readFileSync(path.join(root, 'apps/dashboard/src/types/index.ts'), 'utf8');
const inv = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/inventory/InventoryPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); } };

// ── A232 logo ────────────────────────────────────────────────────────────
ok('A232: engine accepts + renders a logo', () => {
  assert.match(pd, /logo_url\?: string \| null/);
  // 0.6.25: the Branding logo first, the profile's logo_url as the fallback.
  assert.match(pd, /const logoSrc = logo \|\| business\.logo_url \|\| null;/);
  assert.match(pd, /\$\{logoSrc \? `<img class="logo" src="\$\{esc\(logoSrc\)\}"/);
  assert.match(pd, /\.logo \{/);
});
ok('A232: server PATCH whitelist accepts logo_url', () => {
  assert.match(biz, /const EDITABLE = \[[^\]]*'logo_url'[^\]]*\]/);
});
ok('A232: settings exposes a logo URL field and saves it', () => {
  assert.match(bp, /key: 'logo_url'/);
  assert.match(bp, /logo_url: record\.logo_url/);
});
ok('A232: Business type carries logo_url', () => {
  assert.match(ty, /logo_url\?: string \| null;/);
});

// ── A233 stock-take ─────────────────────────────────────────────────────────
ok('A233: Inventory prints a stock-take count sheet', () => {
  assert.match(inv, /import \{ printDocument \}/);
  assert.match(inv, /docType: 'STOCK-TAKE COUNT SHEET'/);
  assert.match(inv, /Print count sheet/);
});
ok('A233 / A394: the sheet has a blank Counted column and never the system figure (blind)', () => {
  assert.match(inv, /\{ label: 'Product' \}, \{ label: 'Category' \}, \{ label: 'Counted', align: 'right' \}/);
  assert.match(inv, /rows: items\.map\(r => \[r\.products\.name, r\.products\.categories\?\.name \?\? '', ''\]\)/);
  assert.doesNotMatch(inv, /System qty/);
  assert.doesNotMatch(inv, /String\(r\.quantity\), '', ''/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
