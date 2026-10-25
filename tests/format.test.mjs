/**
 * format.test.mjs — A471: one way to show money, numbers and dates on the web dashboard.
 *
 * Owner, 2026-10-13: "formatting" — the dashboard mixed "KES 1250", "KES 1,250.00", "1,250" and "Ksh 1,250"
 * (27 files with their own fmt / fmtCur / fmtE …, ~170 ad-hoc toLocaleString / toFixed calls).
 *
 *   node tests/format.test.mjs
 *
 * RUNS, not pins: apps/dashboard/src/lib/format.ts is bundled with esbuild (it imports lib/localDate) and run in
 * Kenya's time zone (TZ=Africa/Nairobi) on fixed instants — money incl. negatives, null, NaN, 'auto', sign and blank;
 * num / qty / pct / litres / compactMoney; dateShort / time / dateTime / dayTime / elapsed / relative.
 * Pins: no file outside the exclusions defines its own money formatter or builds "<code> <number>" by hand
 * (allow-list below, each with its reason), and the screens that had one now import lib/format.
 *
 * MUTATIONS TO CONFIRM BITE (both checked on the bench):
 *   - money's `v < 0 ? '-'` → `''` (negatives lose their sign)     → "money: negatives are -KES 1,250.00" fails
 *   - 'auto' `% 100 === 0 ? 0 : 2` → `2` (never drops the .00)      → "money: 'auto' drops .00 on a whole amount only" fails
 */
process.env.TZ = 'Africa/Nairobi';   // dates are Kenya local — set before any Date is made

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const SRC = path.join(DASH, 'src');
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const eq = (a, b, what = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const assert = (c, msg) => { if (!c) throw new Error(msg); };

function requireFrom(pkgDirs, name) {
  for (const d of pkgDirs) {
    try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ }
  }
  throw new Error(`${name} not installed (npm ci in apps/server or apps/dashboard)`);
}
const esbuild = requireFrom(['apps/server', 'apps/dashboard'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a468-'));
const outFile = path.join(tmp, 'format.mjs');
esbuild.buildSync({ entryPoints: [path.join(SRC, 'lib/format.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: outFile, logLevel: 'silent' });
const F = await import(pathToFileURL(outFile).href);

// ── money ──
await ok('money: "KES 1,250.00" — the code, a plain space (no NBSP), en-KE grouping, 2 dp', () => {
  eq(F.money(1250), 'KES 1,250.00');
  eq(F.money(1234567.891), 'KES 1,234,567.89');
  eq(F.money(0.5), 'KES 0.50');
  assert(!/ | /.test(F.money(1250)), 'no non-breaking space');
});
await ok('money: the business currency when one is passed; an empty one falls back to KES', () => {
  eq(F.money(1250, 'UGX'), 'UGX 1,250.00');
  eq(F.money(1250, 'TZS'), 'TZS 1,250.00');
  eq(F.money(1250, ''), 'KES 1,250.00');
});
await ok('money: negatives are -KES 1,250.00', () => {
  eq(F.money(-1250), '-KES 1,250.00');
  eq(F.money(-0.5, 'UGX'), '-UGX 0.50');
  eq(F.money(-0.001), 'KES 0.00', 'a negative that rounds to zero has no sign:');
});
await ok('money: null, undefined, NaN, junk → KES 0.00; a numeric string (Postgres numeric) is a number', () => {
  eq(F.money(null), 'KES 0.00');
  eq(F.money(undefined), 'KES 0.00');
  eq(F.money(NaN), 'KES 0.00');
  eq(F.money(Infinity), 'KES 0.00');
  eq(F.money('abc'), 'KES 0.00');
  eq(F.money('1250.5'), 'KES 1,250.50');
});
await ok("money: 'auto' drops .00 on a whole amount only", () => {
  eq(F.money(1250, 'KES', { decimals: 'auto' }), 'KES 1,250');
  eq(F.money(1250.5, 'KES', { decimals: 'auto' }), 'KES 1,250.50');
  eq(F.money(1250.004, 'KES', { decimals: 'auto' }), 'KES 1,250');
  eq(F.money(-80, 'KES', { decimals: 'auto' }), '-KES 80');
});
await ok('money: decimals 0 rounds to whole shillings', () => {
  eq(F.money(1250.6, 'KES', { decimals: 0 }), 'KES 1,251');
});
await ok('money: sign puts + on a positive, never on zero', () => {
  eq(F.money(50, 'KES', { sign: true }), '+KES 50.00');
  eq(F.money(-50, 'KES', { sign: true }), '-KES 50.00');
  eq(F.money(0, 'KES', { sign: true }), 'KES 0.00');
});
await ok('money: blank is shown for null / undefined only — zero is still money', () => {
  eq(F.money(null, 'KES', { blank: '—' }), '—');
  eq(F.money(undefined, 'KES', { blank: 'unavailable' }), 'unavailable');
  eq(F.money(0, 'KES', { blank: '—' }), 'KES 0.00');
});

// ── numbers ──
await ok('num: grouped, exactly dp decimals (0 by default); null is 0', () => {
  eq(F.num(1234), '1,234');
  eq(F.num(1234.567, 2), '1,234.57');
  eq(F.num(2.5, 1), '2.5');
  eq(F.num(null), '0');
  eq(F.num(NaN, 2), '0.00');
  eq(F.num(-1234), '-1,234');
});
await ok('qty: grouped, up to 3 decimals, trailing zeros dropped', () => {
  eq(F.qty(2.5), '2.5');
  eq(F.qty(3), '3');
  eq(F.qty(1.23456), '1.235');
  eq(F.qty(12345.5), '12,345.5');
});
await ok('pct: one decimal unless asked; the input is already a percentage', () => {
  eq(F.pct(12.5), '12.5%');
  eq(F.pct(12.34), '12.3%');
  eq(F.pct(40, 0), '40%');
  eq(F.pct(null), '0.0%');
  eq(F.pct(-7.5), '-7.5%');
});
await ok('litres: "1,234.50 L"; dp 0 rounds; blank for null when asked', () => {
  eq(F.litres(1234.5), '1,234.50 L');
  eq(F.litres(1234.5, 0), '1,235 L');
  eq(F.litres(1234.56, 1), '1,234.6 L');
  eq(F.litres(null), '0.00 L');
  eq(F.litres(null, 2, '—'), '—');
  eq(F.litres(0, 2, '—'), '0.00 L');
});
await ok('compactMoney: "KES 1.2M", "KES 45K", "KES 950" — for chart axes and tight tiles', () => {
  eq(F.compactMoney(1_234_567), 'KES 1.2M');
  eq(F.compactMoney(45_000), 'KES 45K');
  eq(F.compactMoney(45_250, 'UGX'), 'UGX 45.3K');
  eq(F.compactMoney(950), 'KES 950');
  eq(F.compactMoney(1_500_000_000), 'KES 1.5B');
  eq(F.compactMoney(-2500), '-KES 2.5K');
  eq(F.compactMoney(null), 'KES 0');
});
await ok('compactMoney: a value that rounds up to 1000 of a unit moves to the next unit', () => {
  eq(F.compactMoney(999_960), 'KES 1M');
  eq(F.compactMoney(999.6), 'KES 1K');
});

// ── dates and times (Kenya, EAT = UTC+3) ──
const NOW = Date.parse('2026-10-13T08:00:00Z');   // 11:00 Tuesday 13 Oct in Nairobi
await ok('dateShort: "13 Oct 2026"; a bare YYYY-MM-DD is that local day; nothing / junk is —', () => {
  eq(F.dateShort('2026-10-13'), '13 Oct 2026');
  eq(F.dateShort('2026-10-01'), '1 Oct 2026');
  eq(F.dateShort('2026-10-12T22:30:00Z'), '13 Oct 2026', 'UTC evening is already the next day in Nairobi:');
  eq(F.dateShort(null), '—');
  eq(F.dateShort(''), '—');
  eq(F.dateShort('not a date'), '—');
  eq(F.dateShort(undefined, 'never'), 'never');
});
await ok('time: "14:05", 24 h as the rest of the app', () => {
  eq(F.time('2026-10-13T11:05:00Z'), '14:05');
  eq(F.time('2026-10-13T21:30:00Z'), '00:30');
  eq(F.time(null), '—');
  eq(F.time(null, '…'), '…');
});
await ok('dateTime: "13 Oct 2026, 14:05"; dayTime: "13 Oct, 14:05"', () => {
  eq(F.dateTime('2026-10-13T11:05:00Z'), '13 Oct 2026, 14:05');
  eq(F.dateTime(null, 'never'), 'never');
  eq(F.dayTime('2026-10-13T11:05:00Z'), '13 Oct, 14:05');
  eq(F.dayTime(null), '—');
});
await ok('elapsed: "45m", "2h 10m" — no "ago" (open for …)', () => {
  eq(F.elapsed('2026-10-13T07:15:00Z', NOW), '45m');
  eq(F.elapsed('2026-10-13T05:50:00Z', NOW), '2h 10m');
  eq(F.elapsed(null, NOW), '—');
});
await ok('relative: just now · 5m ago · 2h 10m ago · yesterday · 3d ago · then the date', () => {
  eq(F.relative('2026-10-13T07:59:40Z', NOW), 'just now');
  eq(F.relative('2026-10-13T07:55:00Z', NOW), '5m ago');
  eq(F.relative('2026-10-13T05:50:00Z', NOW), '2h 10m ago');
  eq(F.relative('2026-10-13T05:00:00Z', NOW), '3h ago');
  eq(F.relative('2026-10-12T05:00:00Z', NOW), 'yesterday', '08:00 on the 12th:');
  eq(F.relative('2026-10-10T08:00:00Z', NOW), '3d ago');
  eq(F.relative('2026-08-01T08:00:00Z', NOW), '1 Aug 2026');
  eq(F.relative(null, NOW), '—');
});

// ── pins: one formatter, everywhere it is shown ──
const EXCLUDED = [
  /^pages\/pos\//,                         // the web POS — edited on its own track
  /^lib\/print[^/]*\.ts$/, /^lib\/escposRenderer/, /^lib\/buildReceiptOrder\.ts$/, /^lib\/printShiftReport\.ts$/,
  /^lib\/documentSpecs\.ts$/,              // receipts and printed documents have their own fixed layouts and tests
  /^lib\/reportDownload\.ts$/,             // Excel wants raw numbers
  /^lib\/format\.ts$/,                     // the formatter itself
];
/** Kept on purpose — file → [definition name, reason]. */
const ALLOW = {
  // A588: a copy of shared/forecourt.ts (kept identical by check-shared-sync) — the desktop POS's pumps screen formats the
  // price per litre with it (the desktop has no lib/format); the web screens use lib/format.
  'lib/forecourt.ts': [['moneyText', 'the shared forecourt copy, for the desktop pumps screen']],
  'pages/ReportsPage.tsx': [['fmtShiftTime', 'a weekday + date + time label ("Tue 13 Oct, 14:05") for the shift list; lib/format has no weekday form']],
};
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(path.relative(SRC, p).split(path.sep).join('/'));
  }
})(SRC);
const scanned = files.filter((f) => !EXCLUDED.some((re) => re.test(f)));
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

await ok('no screen defines its own money / number formatter (fmt, fmtCur, fmtE, money … built on toLocaleString / Intl / toFixed)', () => {
  const bad = [];
  const DEF = /(?:function\s+|const\s+)(fmt\w*|\w*[mM]oney\w*|zMoney)\s*(?::[^=]+)?=?\s*(?:useCallback\(\s*)?\(/g;
  for (const f of scanned) {
    const s = read(f);
    for (const m of s.matchAll(DEF)) {
      const body = s.slice(m.index, m.index + 400).split(/\n(?=\S)|\n\s*(?:const|function|let)\s/)[0];
      if (!/toLocaleString|toLocaleDateString|toLocaleTimeString|Intl\.NumberFormat|toFixed\(/.test(body)) continue;
      if ((ALLOW[f] ?? []).some(([name]) => name === m[1])) continue;
      bad.push(`${f}: ${m[1]}`);
    }
  }
  assert(bad.length === 0, `local formatters left (use lib/format): ${bad.join(', ')}`);
});
await ok('no screen builds "<code> <number>" by hand (KES ${…}, ${currency} ${x.toLocaleString()}, Intl currency style)', () => {
  const bad = [];
  const RX = [
    /\$\{(?:currency|c|cur)\}\s+\$\{[^}`]*(?:toLocaleString|toFixed)/,   // `${currency} ${n.toLocaleString(…)}`
    /\bKES \$\{/, /\bKES \{(?!\/)/,                                          // `KES ${n}` / JSX KES {n}
    /\{currency\} \{[^}]*(?:toLocaleString|toFixed)/,                        // JSX {currency} {n.toLocaleString()}
    /style:\s*'currency'/,                                                  // Intl "Ksh 1,250.00"
  ];
  for (const f of scanned) {
    const s = read(f);
    s.split('\n').forEach((line, i) => { if (RX.some((re) => re.test(line))) bad.push(`${f}:${i + 1}`); });
  }
  assert(bad.length === 0, `hand-built money left: ${bad.join(', ')}`);
});
await ok('the allow-list is still needed (a kept formatter that is gone must leave the list)', () => {
  for (const [f, defs] of Object.entries(ALLOW)) for (const [name] of defs) {
    assert(new RegExp(`function ${name}\\(`).test(read(f)), `${f}: ${name} is gone — drop it from ALLOW`);
  }
});
await ok('the screens that had their own formatter now use lib/format', () => {
  const users = ['components/CountedCloseModal.tsx', 'components/Expiry.tsx', 'components/OrderItems.tsx', 'components/ShiftConfirmations.tsx',
    'components/StockCounts.tsx', 'components/SupplierAccount.tsx', 'components/Wastage.tsx', 'components/DashboardLayout.tsx',
    'pages/OverviewPage.tsx', 'pages/OrdersPage.tsx', 'pages/OpenShiftsPage.tsx', 'pages/QRMenuPage.tsx', 'pages/ShiftReportsPage.tsx',
    'pages/ReportsPage.tsx', 'pages/manager/ManagerReportsPage.tsx', 'pages/manager/ManagerDashboard.tsx', 'pages/manager/ManagerShiftTab.tsx',
    'pages/manager/ManagerMenuTab.tsx', 'pages/customers/CreditAccountsPage.tsx', 'pages/expenses/ExpensesPage.tsx',
    'pages/stock/IngredientsPage.tsx', 'pages/stock/PurchaseOrdersPage.tsx', 'pages/stock/SuppliersPage.tsx', 'pages/products/CombosPage.tsx',
    'pages/settings/DevicesTab.tsx', 'pages/crm/CustomersPage.tsx', 'pages/reports/MonthlyPackTab.tsx'];
  const missing = users.filter((f) => !/from '(?:\.\.?\/)+lib\/format'/.test(read(f)));
  assert(missing.length === 0, `not importing lib/format: ${missing.join(', ')}`);
});
await ok('a hard-coded KES became the business currency where the screen had none', () => {
  for (const f of ['pages/OpenShiftsPage.tsx', 'pages/products/CombosPage.tsx', 'pages/customers/CreditAccountsPage.tsx',
    'pages/products/RecipeDrawer.tsx', 'pages/products/VariantsDrawer.tsx', 'pages/PromotionsPage.tsx']) {
    assert(/useBusiness\(\)\.business\?\.currency \?\? 'KES'/.test(read(f)), `${f}: currency from the business`);
  }
  assert(!/currency="KES"/.test(read('pages/OpenShiftsPage.tsx')), 'OpenShiftsPage passes the business currency to the count dialog');
});
await ok('lib/format is pure (no React) and reuses lib/localDate', () => {
  const s = read('lib/format.ts');
  assert(!/from 'react'/.test(s), 'no React import');
  assert(/import \{ localDateStr \} from '\.\/localDate';/.test(s), 'uses localDateStr');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
