#!/usr/bin/env node
/**
 * check-permission-catalogue — A213 durable guard, rebuilt for A490 (one catalogue, fine keys).
 *
 * The catalogue is shared/permissions.ts: every FINE key, plus LEGACY — the broad keys it replaced (reports.view,
 * settings.manage, products.manage, …), which nothing may check any more (requireAuth and the clients expand them).
 *
 * Fails CI when the code of any app (cloud, web dashboard, till, admin portal) names, as a quoted literal of a
 * permission module ('reports.x', 'menu.x', 'settings.x', …):
 *   1. a key that is NOT in the catalogue — it would never be granted, so the screen or route behind it is owner-only
 *      with nothing saying so (the A57/A213 failure), or
 *   2. a LEGACY key outside the few files that are allowed to name them (the catalogue's copies, the cloud's row list,
 *      the till-change specs that are expanded before use, and tests) — a check of a broad key silently refuses
 *      everyone, because no token or map carries broad keys as such any more.
 *
 * Comments are stripped first. `--self-test` proves the scanner sees what it must.
 * Exit 0 = clean. Exit 1 = findings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAT = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);
const FINE = new Set(CAT.PERMISSION_KEYS);
const LEGACY = new Set(Object.keys(CAT.LEGACY));
// The modules a permission key can start with — a quoted 'module.thing' with one of these is read as a key.
const MODULES = new Set([...FINE, ...LEGACY].map((k) => k.split('.')[0]));

const ROOTS = ['apps/server/src', 'apps/dashboard/src', 'apps/desktop/src', 'apps/admin/src'];
/** Files that may name broad keys: the catalogue's copies, the cloud's registration rows, the till-change specs (their
 *  keys go through expandKeys before any comparison — lib/changeApply, main/changeQueue). */
const LEGACY_OK = [
  /(^|\/)permissions\.ts$/, /permissionCatalogue\.ts$/, /(^|\/)tillChanges\.ts$/,
];
/** Quoted strings that look like keys but are not (file names, settings keys, …). */
const NOT_KEYS = new Set([
  'orders.ts', 'reports.ts', 'settings.json', 'staff.ts', 'shifts.ts', 'inventory.ts', 'customers.ts', 'expenses.ts',
  'products.ts', 'menu.ts', 'stock.ts', 'sales.ts', 'changes.ts', 'fuel.ts', 'parking.ts', 'reservations.ts', 'devices.ts',
  'tables.ts', 'staff.csv', 'products.csv', 'orders.csv', 'reports.csv', 'reports.xlsx', 'menu.csv', 'stock.csv',
]);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/** A line that checks or grants permissions — where an unknown 'module.thing' is a key, not a column ('products.business_id'). */
const CHECK_CONTEXT = /ermission|\bcan\w*\(|\bhas\w*\(|\bholds\w*\(|\bmay\w*\(|\bkeys\b|\bperms\b|\bkey:\s*['"`]|\bp\[/;

function scanText(rel, text) {
  const out = [];
  const lines = stripComments(text).split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/['"`]([a-z_]+)\.([a-z_]+)['"`]/g)) {
      const key = `${m[1]}.${m[2]}`;
      if (!MODULES.has(m[1]) || NOT_KEYS.has(key)) continue;
      if (FINE.has(key)) continue;
      if (LEGACY.has(key)) {
        if (!LEGACY_OK.some((r) => r.test(rel))) out.push({ rel, line: i + 1, key, kind: 'legacy' });
        continue;
      }
      if (CHECK_CONTEXT.test(line)) out.push({ rel, line: i + 1, key, kind: 'unknown' });
    }
  });
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'dist', 'build'].includes(e.name)) walk(p, acc); }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}

if (process.argv.includes('--self-test')) {
  const f = (txt, rel = 'apps/server/src/routes/x.ts') => scanText(rel, txt);
  const checks = [
    ['an unknown key is caught', f(`requirePermission('reports.made_up')`).some((x) => x.kind === 'unknown')],
    ['a broad key in a route is caught', f(`requireAnyPermission('settings.manage')`).some((x) => x.kind === 'legacy')],
    ['a broad key in the till is caught', f(`has('orders.void')`, 'apps/desktop/src/renderer/pages/X.tsx').some((x) => x.kind === 'legacy')],
    ['a fine key passes', f(`requirePermission('reports.sales')`).length === 0],
    ['a comment is ignored', f(`// requirePermission('settings.manage')`).length === 0],
    ['the catalogue may name broad keys', f(`'settings.manage': [...]`, 'apps/server/src/lib/permissions.ts').length === 0],
    ['a non-permission module is ignored', f(`import x from './lib.ts'; const a = 'react.dom'`).length === 0],
    ['a column filter is not a key', f(`q.eq('products.business_id', id)`).length === 0],
    ['an unknown key in a has() check is caught', f(`has('menu.made_up')`, 'apps/dashboard/src/x.tsx').length === 1],
  ];
  for (const [n, okk] of checks) console.log(`  ${okk ? 'ok  ' : 'FAIL'} ${n}`);
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
}

const findings = [];
let files = 0;
for (const r of ROOTS) {
  const abs = path.join(ROOT, r);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    files++;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    findings.push(...scanText(rel, fs.readFileSync(file, 'utf8')));
  }
}
if (files < 100) { console.error(`check-permission-catalogue: only ${files} files scanned — the scanner is blind`); process.exit(1); }

const unknown = findings.filter((f) => f.kind === 'unknown');
const legacy = findings.filter((f) => f.kind === 'legacy');
if (unknown.length || legacy.length) {
  console.error('check-permission-catalogue: FAIL');
  if (unknown.length) {
    console.error('\n  Keys that are not in the catalogue (shared/permissions.ts) — add them there, or use the right key:');
    for (const f of unknown) console.error(`    ${f.rel}:${f.line}  ${f.key}`);
  }
  if (legacy.length) {
    console.error('\n  Broad keys used outside the catalogue (A490) — check the fine key they stand for instead:');
    for (const f of legacy) console.error(`    ${f.rel}:${f.line}  ${f.key}  → ${CAT.LEGACY[f.key].join(', ')}`);
  }
  process.exit(1);
}
console.log(`OK — ${files} files: every permission key named is in the catalogue (${FINE.size} fine keys), and no broad key is checked.`);
