// A582 — the dashboard's half of "All my branches": the branch picker and what it remembers.
//
//   node --no-warnings tests/partner-my-branches-picker-a582.test.mjs
//
// Owner, 2026-10-23: "assume i have partner a and they fully own shop x,y and z they should never see general sales for
// all stores only their store" … "yes i want all my branch feature".
//
// RUNS the REAL picker (apps/dashboard/src/components/BranchPicker.tsx, bundled with esbuild, rendered with
// react-dom/server) and the REAL choice rules (src/lib/branchChoice.ts); pins the wiring of BranchContext, BranchSelector,
// the api client's header and the pages that say "All branches" to the owner.
//
//   P  the picker: a partner of X, Y and Z gets "All my branches (3)" FIRST, then their three — never "All Branches"; the
//      owner "All Branches"; a partner of one branch (or a manager) one branch, disabled; the choice shown when picked.
//   R  what is remembered: 'mine' only for such a partner (the owner, a partner of every branch, of one: never); 'all' only
//      where "All Branches" is; a branch only when it is in the list; else the main branch, as for the owner.
//   G  the wiring: BranchContext offers allowMine only to a partner of two or more who is not of every branch, stores 'mine'
//      for their "every branch", says "All my branches (3)"; the api client sends what is stored as X-Branch-Id; Overview,
//      Reports (and its Excel About sheet) and Analytics say allLabel where the owner reads "All branches".
//
// MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-23):
//   - BranchPicker offering "All Branches" to such a partner (allowAll || allowMine)   → P "never All Branches" fails
//   - restoreChoice taking 'mine' without allowMine                                    → R "the owner never 'mine'" fails
//   - BranchContext storing 'all' for the partner's "every branch"                     → G "stores 'mine'" fails
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'apps/dashboard');
const require = createRequire(path.join(DASH, 'package.json'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`PASS  ${n}`); pass++; } else { console.log(`FAIL  ${n}  ${d}`); fail++; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.a582-'));
const bundle = (entry, out) => {
  require('esbuild').buildSync({ entryPoints: [path.join(DASH, entry)], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, out), logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'] });
  return import(pathToFileURL(path.join(bundleDir, out)).href);
};

try {
  const BP = await bundle('src/components/BranchPicker.tsx', 'picker.mjs');
  const C = await bundle('src/lib/branchChoice.ts', 'choice.mjs');
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const LIST = [{ id: 'x', name: 'Xenon', is_main: true }, { id: 'y', name: 'Yarrow' }, { id: 'z', name: 'Zephyr' }];
  const draw = (p) => renderToStaticMarkup(React.createElement(BP.default, { branches: LIST, activeId: null, allowAll: false, allowMine: false,
    allLabel: 'All branches', onPick() {}, ...p }));
  const options = (html) => [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*(?:<!-- -->[^<]*)*)<\/option>/g)].map((m) => [m[1], m[2].replace(/<!-- -->/g, '')]);

  console.log('\nP. the picker\n');
  const mine = draw({ allowMine: true, allLabel: C.myBranchesLabel(3) });
  const mo = options(mine);
  ok('a partner of X, Y and Z: "All my branches (3)" first, then their three', JSON.stringify(mo) === JSON.stringify([
    ['all', '🌐 All my branches (3)'], ['x', '⭐ Xenon'], ['y', 'Yarrow'], ['z', 'Zephyr']]), JSON.stringify(mo));
  ok('…never "All Branches"', !/All Branches/.test(mine), mine);
  ok('…picked: the select shows it (activeId null → "All my branches (3)" selected)', /<option value="all" selected="">/.test(mine), mine.slice(0, 300));
  const owner = draw({ allowAll: true, allowMine: false });
  ok('the owner: "All Branches" first, as before', options(owner)[0]?.[1] === '🌐 All Branches' && !/All my branches/.test(owner), owner);
  const some = draw({ allowAll: false, allowMine: false, activeId: 'x' });
  ok('a partner of some who may not combine (A550): their branches only, no "all" of any kind', options(some).every(([v]) => v !== 'all'), some);
  const single = renderToStaticMarkup(React.createElement(BP.default, { branches: [LIST[0]], activeId: 'x', allowAll: false, allowMine: true,
    allLabel: 'All my branches (1)', onPick() {} }));
  ok('one branch: just it, disabled, no "all"', /disabled=""/.test(single) && options(single).length === 1, single);
  let picked = 'unset';
  const el = BP.default({ branches: LIST, activeId: 'y', allowAll: false, allowMine: true, allLabel: 'All my branches (3)', onPick: (v) => { picked = v; } });
  el.props.onChange({ target: { value: 'all' } });
  ok('choosing "All my branches" picks null (every branch of theirs)', picked === null);
  el.props.onChange({ target: { value: 'z' } });
  ok('choosing one picks it', picked === 'z');

  console.log('\nR. what is remembered\n');
  const R = (saved, all, mineOk, list = LIST) => JSON.stringify(C.restoreChoice(saved, list, all, mineOk));
  ok("'mine' for such a partner", R('mine', false, true) === '{"kind":"mine"}');
  ok("the owner never 'mine' (a partner's left-over): the main branch", R('mine', true, false) === '{"kind":"branch","id":"x"}');
  ok("a partner of one / who may not combine never 'mine'", R('mine', false, false) === '{"kind":"branch","id":"x"}');
  ok("'all' only where All Branches is: the owner yes, such a partner no (the main branch)", R('all', true, false) === '{"kind":"all"}' && R('all', false, true) === '{"kind":"branch","id":"x"}');
  ok('a branch of theirs kept; another branch (not in the list) never — the main branch', R('z', false, true) === '{"kind":"branch","id":"z"}' && R('w', false, true) === '{"kind":"branch","id":"x"}');
  ok('nothing remembered: the main branch, as the owner', R(null, false, true) === '{"kind":"branch","id":"x"}' && R(null, true, false) === '{"kind":"branch","id":"x"}');
  ok('no branches: none', R('mine', false, true, []) === '{"kind":"mine"}' && R(null, false, false, []) === '{"kind":"none"}');
  ok('the words: "All my branches (3)"; the stored value "mine" (the cloud\'s MY_BRANCHES)', C.myBranchesLabel(3) === 'All my branches (3)' && C.MY_BRANCHES === 'mine'
    && /export const MY_BRANCHES = 'mine'/.test(read('apps/server/src/lib/webPartners.ts')));

  console.log('\nG. the wiring\n');
  const ctx = read('apps/dashboard/src/context/BranchContext.tsx');
  ok('BranchContext: allowMine only for a partner of two or more who is not of every branch',
    /const mine = !all && web\?\.partner === true && data\.length >= 2;/.test(ctx));
  ok("…stores 'mine' for their \"every branch\" (and 'all' only for the owner's)",
    /const mineNow = !branch && allowMine && !allowAll;/.test(ctx) && /branch \? branch\.id : mineNow \? MY_BRANCHES : 'all'/.test(ctx));
  ok('…restores through restoreChoice and never leaves a partner\'s \'mine\' for the owner', /restoreChoice\(saved, data, all, mine\)/.test(ctx)
    && /saved === MY_BRANCHES\) && saved !== pick\.id\) localStorage\.setItem/.test(ctx));
  ok('…says "All my branches (3)" for such a partner, "All branches" for the owner',
    /const allLabel\s+= allowMine && !allowAll \? myBranchesLabel\(branches\.length\) : 'All branches';/.test(ctx));
  ok('BranchSelector draws BranchPicker with allowMine and allLabel', /<BranchPicker [^>]*allowAll=\{allowAll\} allowMine=\{allowMine\} allLabel=\{allLabel\}/.test(read('apps/dashboard/src/components/BranchSelector.tsx')));
  ok("the api client sends what is stored ('mine' included) as X-Branch-Id", /return b && b !== 'all' \? \{ 'X-Branch-Id': b \} : \{\};/.test(read('apps/dashboard/src/lib/api.ts')));
  const rep = read('apps/dashboard/src/pages/ReportsPage.tsx');
  ok('Overview, Reports and Analytics say allLabel where the owner reads "All branches"',
    /activeBranch\?\.name \?\? allLabel/.test(read('apps/dashboard/src/pages/OverviewPage.tsx'))
    && /\{data\.branchName \|\| allLabel\}/.test(rep) && /allLabel=\{allLabel\} showAll=\{allowAll \|\| allMine\}/.test(rep)
    && /\(allMine \? allLabel : ''\)/.test(rep)
    && /branchCtx\.activeBranch\?\.name \?\? branchCtx\.allLabel/.test(read('apps/dashboard/src/pages/analytics/AnalyticsPage.tsx'))
    && /\(branchCtx\.allowAll \|\| branchCtx\.allowMine\) && <option value="">\{branchCtx\.allLabel\}<\/option>/.test(read('apps/dashboard/src/pages/analytics/AnalyticsPage.tsx')));
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
