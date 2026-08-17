#!/usr/bin/env node
/**
 * check-register-consistency.mjs — the register must agree with itself.
 *
 * ── WHY (register A60) ──────────────────────────────────────────────────────
 * AUDIT-REGISTER.md's own preamble says: *"A header that disagrees with its own
 * body is the same failure the register exists to catch."* It then did exactly
 * that. The header read `0 P0` while §A carried `A17 · P0 · OPEN` — the day-15
 * lockout, hidden by the count that decides what gets worked on next.
 *
 * And the rule that IDs are stable and never reused was broken NINE times:
 * A4, A9, A25, A45, A46, A47, A50, A57 and A58 each appear under two headings
 * with different statuses. A57 says both OPEN and CLOSED, in the same file.
 *
 * THREE OF THOSE DUPLICATES WERE ADDED ON 2026-08-11 BY THE SESSION THAT WROTE
 * THIS GATE (A45, A57, A58) — while closing items, having criticised the same
 * failure in the same file hours earlier. That is the argument for a gate rather
 * than more care: the register is now 2,200 lines, and reconciling it by reading
 * is a session's work that nobody schedules.
 *
 * WHAT IT CHECKS
 *   1. No audit ID has two `### An ·` headings. If an item is closed, EDIT the
 *      entry — do not append a second one. IDs are stable, so a duplicate makes
 *      every citation ambiguous.
 *   2. The header's open P0 / P1 / P2 / P3 counts match the entries in the body.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * Whether a status is TRUE — whether something marked CLOSED really is. Only
 * running the code can tell you that, and a gate that appeared to check it would
 * be worse than one that admits it does not (A49).
 *
 * MUTATION-CHECKED (rules 10, 23): duplicate an entry and it names the ID;
 * change a header count and it prints both numbers and the entries it counted.
 *
 * USAGE
 *   node scripts/check-register-consistency.mjs
 *   node scripts/check-register-consistency.mjs --verbose
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import { deriveStatus } from './lib/register-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FILE = resolve(ROOT, 'docs/AUDIT-REGISTER.md');
const VERBOSE = process.argv.includes('--verbose');

const src = readFileSync(FILE, 'utf8');
const lines = src.split('\n');

// ── Parse every entry heading ──────────────────────────────────────────────
// Shape: ### A17 · P0 · OPEN · title   (bold markers are used inconsistently,
// so they are stripped rather than matched — the register's own style varies
// and a gate that demanded one form would fail on prose, not on substance.)
const entries = [];
lines.forEach((line, i) => {
  const m = /^###\s+(A\d+|D\d+)\s*[·|]\s*(.*)$/.exec(line);
  if (!m) return;
  const rest = m[2].replace(/\*\*/g, '');
  const sev = /\bP([0-3])\b/.exec(rest);
  // Status comes from a leading heading FIELD, not a word anywhere in the title:
  // "…fails closed…" in a title must not read as CLOSED (D11). See lib/register-status.mjs.
  const status = deriveStatus(rest);
  entries.push({ id: m[1], sev: sev ? `P${sev[1]}` : null, status, line: i + 1, text: rest.slice(0, 70) });
});

let failed = false;

// ── 1. Duplicate IDs ───────────────────────────────────────────────────────
const byId = new Map();
for (const e of entries) {
  if (!byId.has(e.id)) byId.set(e.id, []);
  byId.get(e.id).push(e);
}
const dupes = [...byId].filter(([, v]) => v.length > 1);

console.log(`check-register-consistency: ${entries.length} entries, ${byId.size} distinct IDs.`);

if (dupes.length) {
  failed = true;
  console.error('\nDUPLICATE AUDIT IDs — each ID must have exactly one entry:\n');
  for (const [id, list] of dupes) {
    const statuses = [...new Set(list.map(e => e.status))];
    console.error(`  ${id}  ${list.length} entries`
      + (statuses.length > 1 ? `  <- CONTRADICTORY: ${statuses.join(' and ')}` : ''));
    for (const e of list) console.error(`      :${e.line}  ${e.status}  ${e.text}`);
  }
  console.error(
    '\nIDs are stable and never reused, so a duplicate makes every citation of\n'
    + 'that ID ambiguous — and a reader who finds the first one may never see the\n'
    + 'second. When an item closes, EDIT its entry in place; do not append a new\n'
    + 'heading. Register A60.');
}

// ── 2. Header counts vs body ───────────────────────────────────────────────
// Header shape: | Open | **A: 1 P0 · 13 P1 · 6 P2 · 5 P3 — D: 3 P0 · …** |
const headerLine = lines.find(l => /^\|\s*Open\s*\|/.test(l));
if (!headerLine) {
  console.error('\nNo "| Open |" header row found — cannot verify counts.');
  failed = true;
} else {
  const parse = (section) => {
    const m = new RegExp(`${section}:\\s*([^—|]*)`).exec(headerLine.replace(/\*\*/g, ''));
    const out = {};
    if (m) for (const p of m[1].matchAll(/(\d+)\s*P([0-3])/g)) out[`P${p[2]}`] = Number(p[1]);
    return out;
  };
  const claimed = { A: parse('A'), D: parse('D') };

  const actual = { A: {}, D: {} };
  for (const e of entries) {
    if (e.status !== 'OPEN' || !e.sev) continue;
    const sec = e.id[0];
    actual[sec][e.sev] = (actual[sec][e.sev] ?? 0) + 1;
  }

  for (const sec of ['A', 'D']) {
    for (const sev of ['P0', 'P1', 'P2', 'P3']) {
      const want = claimed[sec][sev], got = actual[sec][sev] ?? 0;
      if (want === undefined) continue;
      if (want !== got) {
        failed = true;
        console.error(`\nHEADER DISAGREES WITH BODY: section ${sec}, ${sev} — `
          + `header says ${want}, body has ${got}.`);
        const which = entries.filter(e => e.id[0] === sec && e.status === 'OPEN' && e.sev === sev);
        for (const e of which) console.error(`      :${e.line}  ${e.id}  ${e.text}`);
        console.error(
          '  The preamble of this very file says a header disagreeing with its own\n'
          + '  body is the failure the register exists to catch — and this is the\n'
          + '  count that decides what gets worked on next.');
      }
    }
  }
}

// ── 3. A53 — audit IDs cited in code that no entry defines ─────────────────
// The register was opened with sections A, B1-B5, C1-C6, D1-D3, E, F, G, H, I.
// The 08-08 restructure kept only A and D. The code still cites the rest —
// `audit B6`, `audit H14`, `audit C4` — and those entries never reached the
// repository at all, so they are NOT RECOVERABLE. Reconstructing them would
// mean inventing findings, which is worse than a gap a reader can see.
//
// So this does NOT demand they be resolved. It RATCHETS: the set may shrink
// (resolve a reference into the comment, or drop it) and may never grow. A53's
// recorded fix was "when a cited-only line is next touched", which is a policy
// nothing enforces — this is what turns it into something that holds.
const BASELINE_FILE = resolve(ROOT, 'scripts/register-orphan-baseline.json');
const CITE_DIRS = ['apps', 'scripts', 'migrations'];
const cited = new Map();
const walk = (dir) => {
  let out = [];
  let ents;
  try { ents = readdirSync(dir); } catch { return out; }
  for (const e of ents) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mjs|js|sql|ya?ml)$/.test(e)) out.push(p);
  }
  return out;
};
const files = CITE_DIRS.flatMap(d => walk(resolve(ROOT, d)));
files.push(resolve(ROOT, 'render.yaml'));
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of text.matchAll(/\baudit\s+([A-Z]\d{1,2})\b/gi)) {
    const id = m[1].toUpperCase();
    if (!cited.has(id)) cited.set(id, []);
    const ln = text.slice(0, m.index).split('\n').length;
    cited.get(id).push(`${relative(ROOT, f)}:${ln}`);
  }
}
const known = new Set(entries.map(e => e.id));
const orphans = [...cited].filter(([id]) => !known.has(id)).sort(([a], [b]) => a.localeCompare(b));

console.log(`\n${cited.size} audit ID(s) cited in code; ${orphans.length} have no entry.`);
if (orphans.length && VERBOSE) {
  for (const [id, sites] of orphans) {
    console.log(`  ${id.padEnd(4)} ${sites.length} citation(s)`);
    for (const s of sites.slice(0, 3)) console.log(`      ${s}`);
  }
}

let orphanBaseline = null;
try { orphanBaseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).orphans; } catch {}
if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ orphans: orphans.length }, null, 2) + '\n');
  console.log(`Orphan baseline written: ${orphans.length}`);
} else if (orphanBaseline === null) {
  console.error('\nNo orphan baseline. Run with --update.');
  failed = true;
} else if (orphans.length > orphanBaseline) {
  failed = true;
  console.error(
    `\nORPHAN AUDIT CITATIONS ROSE: ${orphanBaseline} -> ${orphans.length}.\n`
    + 'A new citation points at an ID no entry defines. A reference a reader\n'
    + 'cannot follow looks like documentation and is not. Cite a real ID, or say\n'
    + 'what the finding was in the comment itself. Register A53.');
  console.error(`  cited: ${orphans.map(([id]) => id).join(', ')}`);
} else if (orphans.length < orphanBaseline) {
  failed = true;
  console.error(
    `\nORPHAN AUDIT CITATIONS FELL: ${orphanBaseline} -> ${orphans.length}. Good —\n`
    + 'now lower the baseline:  node scripts/check-register-consistency.mjs --update\n'
    + 'Failing on an improvement is deliberate; see typecheck-ratchet.');
}

if (VERBOSE) {
  console.log('\nOpen entries by severity:');
  for (const sev of ['P0', 'P1', 'P2', 'P3']) {
    const list = entries.filter(e => e.status === 'OPEN' && e.sev === sev);
    console.log(`  ${sev}: ${list.map(e => e.id).join(', ') || '—'}`);
  }
}

if (!failed) {
  console.log(`\nOK — no duplicate IDs, and the header agrees with the body. `
    + `(${relative(ROOT, FILE)})`);
}
process.exit(failed ? 1 : 0);
