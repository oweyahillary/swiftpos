#!/usr/bin/env node
/**
 * ops-audit-summary.mjs — A525: npm audit's JSON for every app → one 'vuln_scan' ops event (POST /api/ops/events).
 *
 * Owner, 2026-10-17: "how can I be logging such, like failed deployment, such vulnerabilities and how to fix them". npm
 * audit showed 7 vulnerabilities nobody was told about; .github/workflows/security-scan.yml now runs it every day and
 * this turns what it found into something the admin portal's System page can show: the counts per severity per app,
 * and per vulnerable package what it is, how bad, which versions, whether a fix exists (and whether it is a major
 * upgrade), and the advisories to read.
 *
 *   node scripts/ops-audit-summary.mjs [--commit <sha>] [--run-url <url>] server=a.json dashboard=b.json …
 *     prints the event JSON on stdout. Exit 0; exit 2 when an app's audit could not be read (the event is still printed,
 *     that app marked with its error) — the workflow fails then, and only then.
 *   node scripts/ops-audit-summary.mjs --self-test
 *
 * Status: fail when the SERVER (the only app that runs in the cloud with the shops' data) has a high or critical one;
 * warn when anything else has anything (or an app could not be read); ok when nothing at all.
 * The npm v7+ format: { vulnerabilities: { <name>: { name, severity, isDirect, via, range, fixAvailable } }, metadata }.
 * Capped so the event stays well under the server's 64 KB details limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
export const MAX_PACKAGES_PER_APP = 40;
export const MAX_ADVISORIES = 4;
export const MAX_DETAILS_BYTES = 60 * 1024;

const cut = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);

/** One app's audit JSON (already parsed) → { counts, packages } or { error }. */
export function summariseApp(audit) {
  if (!audit || typeof audit !== 'object') return { error: 'no audit output' };
  if (audit.error) return { error: cut(String(audit.error.summary ?? audit.error.code ?? 'npm audit failed'), 300) };
  if (!audit.vulnerabilities || typeof audit.vulnerabilities !== 'object') return { error: 'not an npm v7+ audit report (no vulnerabilities map)' };
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const packages = [];
  for (const [key, v] of Object.entries(audit.vulnerabilities)) {
    const severity = SEVERITIES.includes(v?.severity) ? v.severity : 'info';
    counts[severity] += 1;
    const via = Array.isArray(v?.via) ? v.via : [];
    const advisories = via.filter((x) => x && typeof x === 'object')
      .map((x) => ({ title: cut(x.title, 160), url: cut(x.url, 200), severity: x.severity ?? null }))
      .slice(0, MAX_ADVISORIES);
    const through = via.filter((x) => typeof x === 'string').slice(0, 6);
    const f = v?.fixAvailable;
    const fixAvailable = f && typeof f === 'object'
      ? { name: cut(String(f.name ?? ''), 80), version: cut(String(f.version ?? ''), 40), isSemVerMajor: f.isSemVerMajor === true }
      : f === true;
    packages.push({ name: cut(String(v?.name ?? key), 100), severity, isDirect: v?.isDirect === true, range: cut(v?.range ?? null, 120), fixAvailable, advisories, through });
  }
  packages.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.isDirect - a.isDirect) || a.name.localeCompare(b.name));
  const total = packages.length;
  return { counts, total, packages: packages.slice(0, MAX_PACKAGES_PER_APP), truncated: total > MAX_PACKAGES_PER_APP };
}

/** Every app → the event: { kind, status, commit, title, details }. */
export function buildEvent(apps, { commit = null, runUrl = null } = {}) {
  const out = {};
  const totals = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const errors = [];
  for (const [app, audit] of Object.entries(apps)) {
    const s = summariseApp(audit);
    out[app] = s;
    if (s.error) { errors.push(app); continue; }
    for (const k of SEVERITIES) totals[k] += s.counts[k];
  }
  const all = SEVERITIES.reduce((n, k) => n + totals[k], 0);
  const server = out.server && !out.server.error ? out.server.counts : null;
  const serverBad = server ? server.critical + server.high : 0;
  const status = serverBad > 0 ? 'fail' : (all > 0 || errors.length) ? 'warn' : 'ok';
  const parts = SEVERITIES.filter((k) => totals[k] > 0).map((k) => `${totals[k]} ${k}`);
  const title = (serverBad > 0
    ? `The server has ${serverBad} high or critical vulnerabilit${serverBad === 1 ? 'y' : 'ies'}`
    : all > 0 ? `Dependencies: ${parts.join(', ')}` : 'No known vulnerabilities')
    + (errors.length ? ` — not scanned: ${errors.join(', ')}` : '');
  const details = { apps: out, totals, errors, run_url: runUrl, scanned_at: new Date().toISOString() };
  // Stay under the server's limit: fewer advisories, then fewer packages, until it fits.
  const size = () => Buffer.byteLength(JSON.stringify(details), 'utf8');
  for (let cap = MAX_PACKAGES_PER_APP; size() > MAX_DETAILS_BYTES && cap > 0; cap = Math.floor(cap / 2)) {
    for (const s of Object.values(out)) {
      if (!s.packages) continue;
      for (const p of s.packages) p.advisories = p.advisories.slice(0, 1);
      if (size() > MAX_DETAILS_BYTES && s.packages.length > cap) { s.packages = s.packages.slice(0, cap); s.truncated = true; }
    }
  }
  return { kind: 'vuln_scan', status, commit: commit || null, title: title.slice(0, 200), details, source: 'github' };
}

function readAudit(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { error: { summary: `could not read ${file}: ${e.message}` } }; }
}

function selfTest() {
  let pass = 0, fail = 0;
  const t = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m ?? ''} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
  const ok = (c, m) => { if (!c) throw new Error(m); };
  const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
  const dash = { auditReportVersion: 2, vulnerabilities: {
    braces: { name: 'braces', severity: 'high', isDirect: false, range: '*', effects: ['micromatch'],
      via: [{ source: 1, name: 'braces', title: 'braces stack exhaustion', url: 'https://github.com/advisories/GHSA-x', severity: 'high', range: '<=3.0.3' }],
      fixAvailable: { name: 'tailwindcss', version: '4.3.3', isSemVerMajor: true } },
    micromatch: { name: 'micromatch', severity: 'moderate', isDirect: false, range: '<=4.0.7', via: ['braces'], fixAvailable: true },
    'source-map-js': { name: 'source-map-js', severity: 'low', isDirect: true, range: '1.0.0', via: [{ title: 'a', url: 'u' }], fixAvailable: false },
  } };
  const serverBad = { auditReportVersion: 2, vulnerabilities: {
    nodemailer: { name: 'nodemailer', severity: 'critical', isDirect: true, range: '<7.0.7', via: [{ title: 'nodemailer header injection', url: 'https://github.com/advisories/GHSA-n', severity: 'critical' }],
      fixAvailable: { name: 'nodemailer', version: '10.0.16', isSemVerMajor: true } },
  } };
  console.log('\nops-audit-summary --self-test\n');
  t('nothing anywhere: ok, "No known vulnerabilities"', () => {
    const e = buildEvent({ server: clean, dashboard: clean });
    eq(e.status, 'ok'); eq(e.kind, 'vuln_scan'); eq(e.title, 'No known vulnerabilities'); eq(e.details.totals.high, 0);
  });
  t('a high in the dashboard only: warn, counts per app and in total', () => {
    const e = buildEvent({ server: clean, dashboard: dash }, { commit: 'abc', runUrl: 'https://x/run/1' });
    eq(e.status, 'warn'); eq(e.commit, 'abc'); eq(e.details.run_url, 'https://x/run/1');
    eq(e.details.apps.dashboard.counts, { critical: 0, high: 1, moderate: 1, low: 1, info: 0 });
    eq(e.details.totals.high, 1); ok(/1 high, 1 moderate, 1 low/.test(e.title), e.title);
  });
  t('per package: severity order, range, fix (major or not), advisories, what it comes through', () => {
    const p = buildEvent({ dashboard: dash }).details.apps.dashboard.packages;
    eq(p.map((x) => x.name), ['braces', 'micromatch', 'source-map-js']);
    eq(p[0].fixAvailable, { name: 'tailwindcss', version: '4.3.3', isSemVerMajor: true });
    eq(p[0].advisories, [{ title: 'braces stack exhaustion', url: 'https://github.com/advisories/GHSA-x', severity: 'high' }]);
    eq(p[1].fixAvailable, true); eq(p[1].through, ['braces']); eq(p[2].fixAvailable, false); eq(p[2].isDirect, true);
  });
  t('a critical or high in the SERVER: fail', () => {
    const e = buildEvent({ server: serverBad, dashboard: clean });
    eq(e.status, 'fail'); ok(/server has 1 high or critical vulnerability/.test(e.title), e.title);
  });
  t('an audit that could not run: the app marked, warn, named in the title', () => {
    const e = buildEvent({ server: clean, admin: { error: { code: 'ENOLOCK', summary: 'no lockfile' } }, desktop: { nope: 1 } });
    eq(e.status, 'warn'); eq(e.details.errors, ['admin', 'desktop']); ok(e.details.apps.admin.error === 'no lockfile');
    ok(/not scanned: admin, desktop/.test(e.title), e.title);
  });
  t('a huge report is capped under 60 KB (packages and advisories cut, truncated said)', () => {
    const v = {};
    for (let i = 0; i < 400; i++) v[`pkg-${i}`] = { name: `pkg-${i}`, severity: 'moderate', range: '*', fixAvailable: true,
      via: Array.from({ length: 10 }, (_, j) => ({ title: 'x'.repeat(150) + j, url: `https://github.com/advisories/GHSA-${i}-${j}`, severity: 'moderate' })) };
    const big = { vulnerabilities: v };
    const e = buildEvent({ server: big, dashboard: big, admin: big, desktop: big });
    ok(Buffer.byteLength(JSON.stringify(e.details)) <= MAX_DETAILS_BYTES, `${Buffer.byteLength(JSON.stringify(e.details))} bytes`);
    eq(e.details.apps.server.total, 400); eq(e.details.apps.server.truncated, true); eq(e.details.totals.moderate, 1600);
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest());
  let commit = null, runUrl = null;
  const apps = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--commit') commit = args[++i] ?? null;
    else if (args[i] === '--run-url') runUrl = args[++i] ?? null;
    else if (/^[a-z][\w-]*=/.test(args[i])) { const [app, ...f] = args[i].split('='); apps[app] = readAudit(f.join('=')); }
    else { console.error(`Unknown argument: ${args[i]}`); process.exit(64); }
  }
  if (!Object.keys(apps).length) { console.error('Usage: ops-audit-summary.mjs [--commit sha] [--run-url url] server=audit.json …'); process.exit(64); }
  const ev = buildEvent(apps, { commit, runUrl });
  process.stdout.write(`${JSON.stringify(ev)}\n`);
  process.exit(ev.details.errors.length ? 2 : 0);
}
