#!/usr/bin/env node
/**
 * check-permission-parity.mjs — the permission key is one word in three places.
 *
 * ── THE BUG THIS EXISTS FOR (register A45) ──────────────────────────────────
 * Observed on a live till, 2026-08-10: a manager opens Receipt, edits the branch
 * address and phone, presses Save, and is told "Your role does not allow this
 * change." Two gates for one action, disagreeing:
 *
 *   ManagerPage.tsx:1083   the tab is listed  ...(isManagerRole ? [...] : [])
 *   business.ts:110        the write needs    requirePermission('settings.manage')
 *
 * The UI promises what the cloud refuses, and the user finds out after typing.
 * §L again: two things that must agree, with nothing comparing them. This is the
 * comparator the register names as the prerequisite for A46's permission split —
 * build it FIRST, or the two sides drift again while being changed.
 *
 * ── THE THIRD SURFACE, found while building this (register A57) ─────────────
 * A45 describes two surfaces. There are three, and the one nobody was looking at
 * is the worst:
 *
 *   role_permissions.permission_id -> permissions.id     (FK, 00_baseline:5212)
 *   requirePermission() allows on req.isOwner | '*' | key  (rbac.ts:20)
 *
 * A key with no row in `permissions` can never be attached to a role, so it can
 * never reach `req.permissionKeys`, so requirePermission FAILS CLOSED and the
 * route becomes owner-only — silently, with no error anywhere. Six enforced keys
 * have no seed in any migration in this repository, covering ~62 routes.
 *
 * READ THAT CAREFULLY: it does NOT mean 62 routes are broken in production. The
 * live `permissions` table is almost certainly seeded — these are the oldest
 * keys and 00_baseline is a schema-only dump. It means THE REPOSITORY CANNOT
 * REBUILD A WORKING PERMISSION SET: a new tenant, a staging rebuild or a PGlite
 * migration test gets a database where those routes are owner-only. That is the
 * A4 shape — the migrations under-represent production — and it is unfalsifiable
 * from the repo alone, which is exactly why it needs a gate rather than a fix.
 *
 * ── WHY A RATCHET, NOT A PASS/FAIL ──────────────────────────────────────────
 * The ground this covers is NOT green today: 6 unregistered keys and 6 with no
 * UI gate. A gate that is red on day one gets switched off, and rule 23 says
 * that is worse than no gate because everyone believes it is watching.
 *
 * So it ratchets, with the same one-way semantics as typecheck-ratchet.mjs —
 * which is this repo's existing answer to this exact problem, and is reused
 * rather than reinvented (rule 17):
 *
 *   count  >  baseline  -> exit 1   you added a new divergence
 *   count  <  baseline  -> exit 1   you fixed some; LOWER THE BASELINE
 *   count === baseline  -> exit 0
 *
 * Fixing failing the run is deliberate and is not a mistake. A ratchet that
 * silently absorbs improvements drifts back up later with nobody noticing.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CHECK ─────────────────────────────────────
 * Whether a UI gate is CORRECT — that the tab hidden by `hasPermission('x')` is
 * the same action the route behind it enforces. A source scan cannot know that.
 * This answers a narrower question honestly: is the same key named on both
 * sides, and does it exist at all? A45's fault would have been caught by the
 * second question alone.
 *
 * It also does not read the production database. It cannot, and pretending
 * otherwise is how an exception file full of unverified prose happens (A49).
 *
 * MUTATION-CHECKED (rules 10, 23): add a requirePermission for an unseeded key
 * and UNREGISTERED rises and the run fails naming the key, the file and the
 * line; seed a missing key and it falls and the run fails asking for a lower
 * baseline.
 *
 * USAGE
 *   node scripts/check-permission-parity.mjs             # check
 *   node scripts/check-permission-parity.mjs --verbose   # list every key
 *   node scripts/check-permission-parity.mjs --update    # rewrite the baseline
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

// fileURLToPath, not new URL(...).pathname — the latter yields /C:/... on
// Windows and path.resolve then prepends the drive again (register A33).
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BASELINE_FILE = resolve(ROOT, 'scripts/permission-parity-baseline.json');

const VERBOSE = process.argv.includes('--verbose');
const UPDATE  = process.argv.includes('--update');

const CLOUD_DIRS = ['apps/server/src'];
const UI_DIRS    = ['apps/dashboard/src', 'apps/desktop/src/renderer'];
const MIGRATIONS = 'migrations';

/**
 * Blank out comments, preserving line/column offsets.
 *
 * NOT OPTIONAL, and this file proves it: apps/server/src/middleware/
 * asyncHandler.ts:54 contains `requirePermission('x')` inside a comment
 * explaining middleware arrays. Without this, the scanner reports a phantom
 * permission key called "x" — which it did, on the first run, before this
 * existed. Comments are code to a regex (rule 23, and the third time this
 * session per the mailer suite's header).
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/** Blank out SQL comments (`-- …`) for the same reason. */
function stripSqlComments(src) {
  return src.replace(/--[^\n]*/g, m => ' '.repeat(m.length));
}

function walk(dir, exts) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { out.push(...walk(p, exts)); continue; }
    if (exts.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out;
}

/** Record every key with the file and line it was found on, for the report. */
function record(map, key, file, idx, src) {
  const line = src.slice(0, idx).split('\n').length;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(`${relative(ROOT, file)}:${line}`);
}

function scan(dirs, patterns, exts = /\.(ts|tsx)$/) {
  const found = new Map();
  let files = 0;
  for (const dir of dirs) {
    for (const file of walk(join(ROOT, dir), exts)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      files++;
      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src))) record(found, m[1], file, m.index, src);
      }
    }
  }
  return { found, files };
}

// ── 1. ENFORCED — what the cloud actually demands ──────────────────────────
//
// BOTH gate forms, and the second is not optional. A46's split re-points routes
// to `requireAnyPermission('devices.approve', 'settings.manage')`, and the
// first version of this scanner matched only `requirePermission(` — so on the
// very commit that introduced the split it reported 13 enforced keys and could
// not see the three new ones. A gate blind to the change it exists to guard is
// rule 23's failure exactly, caught here by the count not moving.
//
// requireAnyPermission takes N keys, so every quoted key inside the call is
// extracted rather than just the first.
const { found: enforced, files: cloudFiles } = scan(CLOUD_DIRS, [
  /requirePermission\(\s*['"]([\w.]+)['"]/g,
]);
{
  const anyCall = /requireAnyPermission\(([^)]*)\)/g;
  let anySites = 0, anyKeys = 0, literalSites = 0;
  for (const dir of CLOUD_DIRS) {
    for (const file of walk(join(ROOT, dir), /\.(ts|tsx)$/)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // Ground truth, counted by literal string rather than by the pattern
      // under test. The first version of this self-check compared the pattern
      // against itself, so renaming the pattern found zero sites, satisfied
      // "0 sites means nothing to check", and passed green — the identical
      // defect one level up. Found by re-running the mutation.
      literalSites += src.split('requireAnyPermission(').length - 1;
      let m;
      anyCall.lastIndex = 0;
      while ((m = anyCall.exec(src))) {
        anySites++;
        for (const q of m[1].match(/['"][\w.]+['"]/g) ?? []) {
          anyKeys++;
          record(enforced, q.slice(1, -1), file, m.index, src);
        }
      }
    }
  }

  // SELF-CHECK. Blinding this scanner does not necessarily move any ratcheted
  // count — the keys it stops seeing may all be registered and owner-only — so
  // the gate can go blind and still exit 0. That is exactly the defect it is
  // built to catch, in itself (rule 23), and it was found by mutation: changing
  // the pattern dropped enforced keys from 16 to 13 on a green run.
  if (literalSites !== anySites || (literalSites > 0 && anyKeys === 0)) {
    console.error(
      `\ncheck-permission-parity IS BLIND: the source contains ${literalSites} `
      + `requireAnyPermission( call site(s); the extraction pattern matched `
      + `${anySites} and pulled ${anyKeys} key(s) out of them.\n`
      + 'The pattern has drifted from the code it scans, so every count below is\n'
      + 'a subset being reported as a total. Fix the pattern, not this check.');
    process.exit(1);
  }
  if (enforced.size === 0) {
    console.error('\ncheck-permission-parity IS BLIND: no enforced keys found at all.');
    process.exit(1);
  }
}

// ── 2. REGISTERED — what a role can be granted, per the migrations ─────────
// A key must exist as a `permissions` row before role_permissions can reference
// it (FK, 00_baseline:5212). Parsed from the INSERT blocks rather than assumed.
const registered = new Map();
let migrationFiles = 0;
// `migrations/archive/**` is legacy and superseded — those files are NEVER run,
// so a key defined only there is NOT registered. The first version of this
// scanner walked them and reported printers.manage, printers.view and
// ingredients.view as registered on the strength of files nobody executes.
// That is A49's shape exactly: a false claim, in the position where a false
// claim silences the gate. Counted keys are unaffected (none of the three is
// enforced) — the correctness is the point, not the number.
for (const file of walk(join(ROOT, MIGRATIONS), /\.sql$/)) {
  if (/[\\/]archive[\\/]/.test(file)) continue;
  const src = stripSqlComments(readFileSync(file, 'utf8'));
  migrationFiles++;
  const insert = /INSERT\s+INTO\s+(?:public\.)?permissions\b[\s\S]*?;/gi;
  let block;
  while ((block = insert.exec(src))) {
    const rows = /\(\s*['"]([\w.]+)['"]/g;
    let r;
    while ((r = rows.exec(block[0]))) {
      record(registered, r[1], file, block.index + r.index, src);
    }
  }
}

// ── 3. UI — what a screen tells the user they may do ───────────────────────
// Three spellings, all live: the hook, the shorthand helper, and the object
// field NAV_ITEMS uses. Requiring a dotted key keeps `can(` from matching
// unrelated helpers.
const { found: ui, files: uiFiles } = scan(UI_DIRS, [
  /\bhasPermission\(\s*['"]([\w]+\.[\w]+)['"]/g,
  /\bcan\(\s*['"]([\w]+\.[\w]+)['"]/g,
  /\bpermission:\s*['"]([\w]+\.[\w]+)['"]/g,
]);

// ── 3b. GRANTED — which keys any non-owner role is actually given ──────────
// A key that no migration grants to any role can only ever be held by the owner
// (who carries '*'), so no screen can meaningfully gate on it and its absence
// from the UI is not a divergence. Parsed from the role_permissions seeds, so
// it is computed from the repo rather than asserted in prose — A49 is what a
// file of unverified reasons costs.
const granted = new Set();
for (const file of walk(join(ROOT, MIGRATIONS), /\.sql$/)) {
  if (/[\\/]archive[\\/]/.test(file)) continue;
  const src = stripSqlComments(readFileSync(file, 'utf8'));
  const ins = /INSERT\s+INTO\s+(?:public\.)?role_permissions\b[\s\S]*?;/gi;
  let b;
  while ((b = ins.exec(src))) {
    for (const k of b[0].match(/'[a-z_]+\.[a-z_]+'/g) ?? []) granted.add(k.slice(1, -1));
  }
}
const sorted = m => [...m].sort(([a], [b]) => a.localeCompare(b));

// Enforced, but no `permissions` row exists to grant it -> owner-only on any
// database built from this repository. requirePermission fails closed.
const unregistered = sorted(enforced).filter(([k]) => !registered.has(k));

// Enforced, but no screen names the key -> the A45 class.
//
// ── WHY THIS IS SPLIT IN TWO (changed 2026-08-11, A46) ──────────────────────
// The first version counted every enforced key with no UI gate, and that
// conflated two different things:
//
//   * a key a MANAGER can hold, that no screen names   <- A45's shape, a defect
//   * a key only the owner can ever hold               <- not a defect at all
//
// devices.approve gates approve / reject / delete / authorise-handover.
// FleetPage.tsx is READ-ONLY — zero write calls — so those four routes have no
// dashboard UI whatsoever. "No UI gate names the key" there means "there is no
// UI", which is not a disagreement between two gates and cannot be fixed by
// adding one.
//
// So the RATCHET runs on the grantable subset, and the raw figure is still
// printed. The distinction is computed from the role_permissions seeds, not
// declared: if a key is ever granted to a role, it becomes ratcheted
// automatically and this stops being a way to hide anything.
//
// BE SUSPICIOUS OF THIS CHANGE. It was made while adding three keys that it
// then exempted, which is the exact shape of loosening a gate to accommodate
// your own change (rule 20). The argument that it is not: the raw number is
// still reported and still visible, the exemption is derived from the tree
// rather than asserted, and a key becomes counted the moment anyone grants it —
// which is also the moment a missing UI gate starts to matter.
const ungatedRaw   = sorted(enforced).filter(([k]) => !ui.has(k));
const ungated      = ungatedRaw.filter(([k]) => granted.has(k));
const ungatedOwner = ungatedRaw.filter(([k]) => !granted.has(k));

// A screen gates on a key the cloud never enforces AND the registry never
// defines -> `hasPermission` is `permissions['*'] || permissions[key]`
// (POSAuthContext.tsx:134), and a key with no `permissions` row can never be
// granted, so the gate is ALWAYS FALSE for anyone who is not the owner.
//
// This was written as a HARD FAIL, on the assumption that there were none.
// There are two, and they hide three manager nav items (register A58). The
// assumption was wrong, the measurement corrected it, and it is ratcheted with
// the others rather than left red — a gate nobody can make green gets switched
// off, which is the failure rule 23 names.
const phantom = sorted(ui).filter(([k]) => !enforced.has(k) && !registered.has(k));

const counts = {
  unregistered: unregistered.length,
  ungated:      ungated.length,
  phantom:      phantom.length,
};

// ── Report ─────────────────────────────────────────────────────────────────
console.log(
  `check-permission-parity: ${enforced.size} key(s) enforced across ${cloudFiles} cloud file(s); `
  + `${registered.size} registered in ${migrationFiles} migration(s); `
  + `${ui.size} named by ${uiFiles} UI file(s).`);

const show = (title, list, note) => {
  if (!list.length) return;
  console.log(`\n${title}`);
  for (const [k, sites] of list) {
    const routes = enforced.get(k)?.length ?? 0;
    console.log(`  ${k.padEnd(22)} ${routes ? `${routes} route(s)` : ''}`);
    if (VERBOSE) for (const s of sites.slice(0, 4)) console.log(`      ${s}`);
  }
  if (note) console.log(`  ${note}`);
};

show('ENFORCED BUT NOT REGISTERED — owner-only on a rebuilt database:', unregistered,
     '(requirePermission fails closed; role_permissions cannot reference a missing row.)');
show('GRANTABLE, ENFORCED, AND NO UI GATE NAMES IT — the A45 class (ratcheted):', ungated);
if (VERBOSE) {
  show('Enforced with no UI gate, but grantable to NOBODY — owner-only, not ratcheted:',
       ungatedOwner, '(no role is granted these in any migration, so no screen can gate on them.)');
} else if (ungatedOwner.length) {
  console.log(`\n${ungatedOwner.length} further enforced key(s) have no UI gate but are `
    + `owner-only (granted to no role). Not ratcheted; --verbose lists them.`);
}

if (UPDATE) {
  writeFileSync(BASELINE_FILE, JSON.stringify(counts, null, 2) + '\n');
  console.log(`\nBaseline written: ${JSON.stringify(counts)}`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
} catch {
  console.error(`\nNo baseline at ${relative(ROOT, BASELINE_FILE)}. Run with --update.`);
  process.exit(1);
}

let failed = false;

if (phantom.length) {
  console.error('\nUI GATES ON A KEY THAT EXISTS NOWHERE:\n');
  for (const [k, sites] of phantom) {
    console.error(`  ${k}`);
    for (const s of sites) console.error(`      ${s}`);
  }
  console.error(
    '\nThe cloud does not enforce it and no migration defines it. hasPermission\n'
    + 'is `permissions[\'*\'] || permissions[key]`, and a key with no permissions\n'
    + 'row can never be granted — so this gate is ALWAYS FALSE for anyone who is\n'
    + 'not the owner, and the screen behind it is unreachable. Register A58.');
}

for (const [name, count] of Object.entries(counts)) {
  const want = baseline[name];
  if (want === undefined) {
    console.error(`\nBaseline has no entry for "${name}". Run with --update.`);
    failed = true;
  } else if (count > want) {
    failed = true;
    console.error(
      `\n${name.toUpperCase()} ROSE: ${want} -> ${count}.\n`
      + 'A new permission divergence was added. The keys are listed above; the\n'
      + 'new one is whichever is not in the baseline commit. Register A45/A57.');
  } else if (count < want) {
    failed = true;
    console.error(
      `\n${name.toUpperCase()} FELL: ${want} -> ${count}. Good — now LOWER THE BASELINE:\n`
      + `  node scripts/check-permission-parity.mjs --update\n`
      + 'Failing on an improvement is deliberate (same as typecheck-ratchet): a\n'
      + 'ratchet that absorbs fixes silently drifts back up with nobody noticing.');
  }
}

if (!failed) {
  console.log(
    `\nOK — no new permission divergence. `
    + `(unregistered ${counts.unregistered}, ungated ${counts.ungated}, `
    + `phantom ${counts.phantom} — all at baseline.)`);
}

process.exit(failed ? 1 : 0);
