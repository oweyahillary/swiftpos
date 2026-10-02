#!/usr/bin/env node
/**
 * check-permission-catalogue — A213 durable guard.
 *
 * Every permission key the code references anywhere (server enforcement, UI nav
 * gates, hasPermission calls, the default-role sets) MUST appear in the canonical
 * PERMISSION_CATALOGUE (apps/server/src/lib/permissionCatalogue.ts). The boot
 * self-heal registers that catalogue into the live DB, so "in the catalogue" is
 * what guarantees "registered live". If a new key is referenced but not added to
 * the catalogue, it would silently fail closed — so this fails CI instead.
 *
 * Exit 0 = every referenced key is catalogued. Exit 1 = missing key(s).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── the canonical catalogue keys ──────────────────────────────────────────────
const catSrc = fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/permissionCatalogue.ts'), 'utf8');
const catBlock = /PERMISSION_CATALOGUE[\s\S]*?\n\];/.exec(catSrc)?.[0] ?? '';
const catalogue = new Set([...catBlock.matchAll(/key:\s*'([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]));

// ── keys referenced by the code ───────────────────────────────────────────────
const grep = (pattern) => {
  try {
    return execSync(
      `grep -rhoE "${pattern}" apps/dashboard/src apps/server/src 2>/dev/null || true`,
      { cwd: ROOT, encoding: 'utf8' },
    );
  } catch { return ''; }
};
const referenced = new Set();
const collect = (text) => {
  for (const m of text.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) referenced.add(m[1]);
};
collect(grep("hasPermission\\('[a-z_.]+'\\)"));
collect(grep("require(Permission|AnyPermission)\\('[a-z_.]+'"));
collect(grep("permission: '[a-z_.]+'"));
// default-role sets (CASHIER_KEYS / MANAGER_DENY) live in one file
collect(fs.readFileSync(path.join(ROOT, 'apps/server/src/lib/defaultRolePermissions.ts'), 'utf8')
  .match(/'[a-z_]+\.[a-z_]+'/g)?.join('\n') ?? '');

// A few dotted strings are not permission keys — ignore anything that isn't a
// plausible permission (module.action) and known false positives.
const IGNORE = new Set(['x.y']);
const missing = [...referenced].filter(k => !catalogue.has(k) && !IGNORE.has(k)).sort();

if (missing.length) {
  console.error('check-permission-catalogue: FAIL');
  console.error('  These keys are referenced in code but missing from PERMISSION_CATALOGUE:');
  for (const k of missing) console.error(`    - ${k}`);
  console.error('  Add them to apps/server/src/lib/permissionCatalogue.ts (the boot self-heal registers it).');
  process.exit(1);
}
console.log(`OK — all ${referenced.size} referenced permission keys are in the canonical catalogue (${catalogue.size} keys).`);
process.exit(0);
