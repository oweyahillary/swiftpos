#!/usr/bin/env node
/**
 * check-api-routes.mjs — does every API call the DASHBOARD makes hit a real
 * route on the SERVER, with a matching HTTP method?
 *
 * WHY THIS EXISTS
 * The dashboard calls ~275 endpoints; the server defines ~250 routes. Nothing
 * compared the two, so a renamed route, a typo'd path, or a GET-called-as-POST
 * would 404/405 only in the browser, in whichever page happened to call it.
 *
 * WHAT IT CHECKS
 *   Server routes  = mount prefix (routes/index.ts) + router.<method>('<path>')
 *                    in each route file, attributed to the correct router var.
 *   Dashboard calls= api.<method>('<path>') and raw fetch('…/api/…') across
 *                    apps/dashboard/src, with ${…} params normalised to :p.
 *   FAILS if a dashboard call has no server path, or the method differs.
 *
 * Comments are stripped first (a commented-out fetch is not a call). Template
 * literals with a query built by a ternary are truncated at the first ${.
 *
 *   node scripts/check-api-routes.mjs [--verbose] [--self-test]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRV = path.join(ROOT, 'apps/server/src');
const DASH = path.join(ROOT, 'apps/dashboard/src');
const VERBOSE = process.argv.includes('--verbose');
const SELF_TEST = process.argv.includes('--self-test');

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const normSeg = p => '/' + p.split('/').filter(Boolean).map(s => (s.startsWith(':') || s === ':p') ? ':p' : s).join('/');

function serverRoutes() {
  const idx = stripComments(fs.readFileSync(path.join(SRV, 'routes/index.ts'), 'utf8'));
  const varToFile = {};
  for (const m of idx.matchAll(/import\s+(?:(\w+)|\{\s*([^}]+)\s*\})\s+from\s+'\.\/([\w-]+)'/g)) {
    if (m[1]) varToFile[m[1]] = m[3];
    if (m[2]) for (const v of m[2].split(',')) varToFile[v.trim()] = m[3];
  }
  const mounts = [];
  for (const m of idx.matchAll(/router\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g))
    if (varToFile[m[2]]) mounts.push({ prefix: m[1], file: varToFile[m[2]], importVar: m[2] });

  const fileCache = {};
  const parse = file => {
    if (fileCache[file]) return fileCache[file];
    let src; try { src = stripComments(fs.readFileSync(path.join(SRV, 'routes', file + '.ts'), 'utf8')); } catch { return fileCache[file] = {}; }
    const byRecv = {};
    for (const m of src.matchAll(/\b(\w*[Rr]outer)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\3/g))
      (byRecv[m[1]] ??= []).push([m[2].toUpperCase(), m[4]]);
    return fileCache[file] = byRecv;
  };

  const byPath = new Map();
  for (const { prefix, file, importVar } of mounts) {
    const byRecv = parse(file);
    const recv = byRecv[importVar] ? importVar : (Object.keys(byRecv).length === 1 ? Object.keys(byRecv)[0] : 'router');
    for (const [method, sub] of (byRecv[recv] || [])) {
      const full = normSeg('/api/' + prefix + '/' + sub);
      (byPath.get(full) ?? byPath.set(full, new Set()).get(full)).add(method);
    }
  }
  return { byPath, mounts: mounts.length };
}

const walk = d => { let o = []; for (const e of fs.readdirSync(d)) { const p = path.join(d, e); if (e === 'node_modules' || e === 'dist') continue; if (fs.statSync(p).isDirectory()) o.push(...walk(p)); else if (/\.(ts|tsx)$/.test(e)) o.push(p); } return o; };
const dnorm = raw => {
  let p = raw.replace(/\$\{[^}]*\}/g, ':p').replace(/\$\{.*$/, '').split('?')[0].split('#')[0];
  return normSeg(p);
};
function dashboardCalls() {
  const calls = [];
  for (const f of walk(DASH)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const rel = f.replace(DASH + '/', '');
    for (const m of src.matchAll(/\bapi\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]*)\2/g))
      calls.push({ method: m[1].toUpperCase(), path: dnorm(m[3]), rel, raw: m[3] });
    for (const m of src.matchAll(/fetch\(\s*(['"`])([^'"`]*\/api\/[^'"`]*)\1(\s*,\s*\{[\s\S]*?\})?/g)) {
      const url = m[2], opts = m[3] || ''; const mm = /method:\s*['"`](\w+)['"`]/.exec(opts);
      calls.push({ method: (mm ? mm[1] : 'GET').toUpperCase(), path: dnorm(url.slice(url.indexOf('/api/'))), rel, raw: url });
    }
  }
  return calls;
}

function matchMethods(byPath, cp) {
  if (byPath.has(cp)) return byPath.get(cp);
  const cs = cp.split('/');
  for (const [sp, ms] of byPath) {
    const ss = sp.split('/'); if (ss.length !== cs.length) continue;
    let ok = true;
    for (let i = 0; i < ss.length; i++) { if (ss[i] === cs[i] || ss[i] === ':p' || cs[i] === ':p') continue; ok = false; break; }
    if (ok) return ms;
  }
  return null;
}

const { byPath, mounts } = serverRoutes();

if (SELF_TEST) {
  const bad = matchMethods(byPath, normSeg('/api/totally-not-a-route'));
  const wrongMethod = (() => { const ms = matchMethods(byPath, normSeg('/api/kitchen/tickets')); return ms && !ms.has('DELETE'); })();
  const good = !!matchMethods(byPath, normSeg('/api/tables'));
  const ok = bad === null && wrongMethod && good;
  console.log(ok ? '✓ self-test: bogus path unmatched, wrong method caught, real path matched' : '✗ self-test FAILED');
  process.exit(ok ? 0 : 1);
}

const calls = dashboardCalls();
const unmatched = [], mismatch = [], seen = new Set();
for (const c of calls) {
  const ms = matchMethods(byPath, c.path);
  if (!ms) { const k = c.method + c.path + c.rel; if (!seen.has(k)) { seen.add(k); unmatched.push(c); } }
  else if (!ms.has(c.method)) mismatch.push({ ...c, has: [...ms].join('/') });
}
if (VERBOSE) console.log(`server ${byPath.size} paths / ${mounts} mounts · dashboard ${calls.length} call-sites`);

let fatal = 0;
if (unmatched.length) { fatal += unmatched.length; console.error(`\n✗ dashboard calls with no server route — ${unmatched.length}`); for (const c of unmatched) console.error(`    ${c.method} ${c.path}  (${c.rel})  «${c.raw}»`); }
if (mismatch.length) { fatal += mismatch.length; console.error(`\n✗ method mismatches — ${mismatch.length}`); for (const c of mismatch) console.error(`    called ${c.method}, server has ${c.has}: ${c.path}  (${c.rel})`); }

if (fatal) { console.error(`\ncheck-api-routes: ${fatal} contract break(s).`); process.exit(1); }
console.log(`check-api-routes: OK — all ${calls.length} dashboard calls hit a real route with a matching method.`);
