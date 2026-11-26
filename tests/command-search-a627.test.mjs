/**
 * command-search-a627.test.mjs — A627 (owner, 2026-11-26: "add a search functionality that they can use to navigate the
 * system, web specifically"): the web dashboard's global search (Cmd/Ctrl-K command palette).
 *
 *   node --no-warnings tests/command-search-a627.test.mjs
 *
 * Source-level, like the other dashboard guards: every destination the palette offers is a REAL route in App.tsx (no dead
 * links), the palette is gated by permission + vertical and wired to Cmd/Ctrl-K + the Search button, and it is mounted.
 *
 * MUTATIONS TO CONFIRM BITE: a destination path typo'd → "every destination is a real route" fails; the permission gate
 * dropped from visibleDestinations → "gated by permission" fails; the Cmd/Ctrl-K handler removed → "opens on Cmd/Ctrl-K" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

console.log('\nA627 — the dashboard global search (command palette)\n');

const app = read('apps/dashboard/src/App.tsx');
const destSrc = read('apps/dashboard/src/lib/commandDestinations.ts');
const palette = read('apps/dashboard/src/components/CommandPalette.tsx');
const layout = read('apps/dashboard/src/components/DashboardLayout.tsx');

// The route paths declared in App.tsx, normalised (no leading slash) — both `path="…"` and `<Navigate to="…">` targets.
const routePaths = new Set();
for (const m of app.matchAll(/\bpath="([^"]+)"/g)) routePaths.add(m[1].replace(/^\//, ''));
const navTargets = new Set();
for (const m of app.matchAll(/\bto="(\/dashboard[^"]*)"/g)) navTargets.add(m[1]);

// The destinations the palette offers (its `to:` values).
const dests = [...destSrc.matchAll(/\bto:\s*'([^']+)'/g)].map((m) => m[1]);

// A full dashboard path is reachable when its relative path is a route, or it splits into a parent route + a nested route
// (e.g. 'settings/business' + 'profile'), or it is a redirect target (Navigate to=).
const reachable = (to) => {
  if (navTargets.has(to)) return true;
  const rel = to.replace(/^\/dashboard\/?/, '').replace(/^\//, '');
  if (rel === '') return true;                 // the index (Overview)
  if (routePaths.has(rel)) return true;        // a top-level route ('orders', 'stock/counts', 'kds' from path="/kds")
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const suffix = parts.slice(i).join('/');
    if (routePaths.has(prefix) && routePaths.has(suffix)) return true;   // parent route + nested route
  }
  return false;
};

ok('the palette offers a healthy set of destinations', () => {
  assert.ok(dests.length >= 40, `only ${dests.length} destinations`);
  assert.equal(new Set(dests).size, dests.length, 'no duplicate destination');
});

ok('every destination is a real route in App.tsx (no dead links)', () => {
  const dead = dests.filter((to) => !reachable(to));
  assert.deepEqual(dead, [], `dead links: ${dead.join(', ')}`);
});

ok('the buried switches the owner wanted are reachable by search', () => {
  for (const to of ['/dashboard/settings/business/profile', '/dashboard/settings/users/roles',
    '/dashboard/settings/business/payments', '/dashboard/settings/business/integrations/mpesa']) {
    assert.ok(dests.includes(to), `missing ${to}`);
    assert.ok(reachable(to), `not reachable ${to}`);
  }
  // the shift-sales switch lives on Business profile — findable by its words
  assert.match(destSrc, /shift sales[\s\S]*settings\/business\/profile|business\/profile[\s\S]*shift sales/);
});

ok('search is gated by permission AND the business vertical (same as the sidebar)', () => {
  assert.match(destSrc, /export function visibleDestinations\(/);
  assert.match(destSrc, /d\.keys\b[\s\S]*some\(\(k\) => can\(k\)\)/);     // ANY of the keys, via can()
  assert.match(destSrc, /d\.verticals[\s\S]*includes\(v\)/);              // business-type filter
  // fuel/kitchen/reservations destinations carry the food/fuel verticals so a shop never finds them
  assert.match(destSrc, /verticals:\s*FOOD/);
});

ok('the palette opens on Cmd/Ctrl-K and on the Search button event, and closes on Esc', () => {
  assert.match(palette, /\(e\.metaKey \|\| e\.ctrlKey\) && \(e\.key === 'k' \|\| e\.key === 'K'\)/);
  assert.match(palette, /addEventListener\('zaptill:open-search'/);
  assert.match(palette, /e\.key === 'Escape'/);
  assert.match(palette, /rankDestinations\(visibleDestinations\(can, vertical\), query\)/);
});

ok('keyboard navigation: arrows move, Enter opens the selected destination', () => {
  assert.match(palette, /e\.key === 'ArrowDown'/);
  assert.match(palette, /e\.key === 'ArrowUp'/);
  assert.match(palette, /e\.key === 'Enter'[\s\S]*go\(d\.to\)/);
});

ok('the palette is mounted once and both Search triggers fire its event', () => {
  assert.match(layout, /import CommandPalette from '\.\/CommandPalette'/);
  assert.match(layout, /<CommandPalette \/>/);
  assert.match(layout, /data-testid="nav-search"[\s\S]*zaptill:open-search/);          // sidebar
  assert.match(layout, /data-testid="nav-search-mobile"[\s\S]*zaptill:open-search/);   // phone top bar
});

ok('ranking prefers a label prefix, then word-start, then substrings and keywords', () => {
  assert.match(destSrc, /export function rankDestinations\(/);
  assert.match(destSrc, /label\.startsWith\(q\)/);
  assert.match(destSrc, /\.keywords ?\?\? \[\]/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
