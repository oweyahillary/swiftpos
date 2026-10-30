#!/usr/bin/env node
/**
 * check-shared-sync.mjs — fail CI when a shared file diverges between apps.
 *
 * There is no shared package in this monorepo and adding one means build
 * tooling across three apps with different bundlers. The pragmatic alternative
 * is a copied file plus a check that the copies are identical — which is the
 * same trick scripts/schema-parity.mjs already plays for Postgres and SQLite.
 *
 * This exists because of audit H2. VAT was overstated on every discounted sale
 * for months because /open and /pay each computed the same money their own way.
 * Parking has the same shape with worse odds: the till prices a session offline
 * at the barrier, the server prices it again on sync, and if those two ever
 * disagree the drawer will not balance and nobody will know which figure was
 * right. Two copies of one file is acceptable. Two implementations is not.
 *
 * To change a shared file: edit one copy, copy it to the others verbatim, run
 * its test vectors, commit all copies together.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each entry: the canonical copy first, then every copy that must match it. */
const SHARED = [
  {
    // 0.6.23: the mouse wheel never changes a number field (the till and the web).
    name: 'numberInputs.ts',
    copies: [
      'shared/numberInputs.ts',
      'apps/desktop/src/shared/numberInputs.ts',
      'apps/dashboard/src/lib/numberInputs.ts',
    ],
  },
  // confirmReasons.ts (0.6.27) moved to packages/core in shared-components step 1 — imported as
  // '@zaptill/core/confirmReasons', no copies (docs/SHARED-COMPONENTS-PLAN.md). The CORE check below keeps it that way.
  // Step 2 (batches A and B) moved 26 more the same way — every file in packages/core/src (the plan's "Step 2 progress").
];

const sha = (p) =>
  crypto.createHash('sha256')
    // Normalise line endings only. The repo has mixed CRLF/LF from Windows
    // editing, and a check that fails on that alone would be turned off within
    // a week — which is worse than not having it.
    .update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

let problems = 0;
let checked = 0;

for (const { name, copies } of SHARED) {
  const present = copies.filter((c) => fs.existsSync(path.join(ROOT, c)));
  const missing = copies.filter((c) => !fs.existsSync(path.join(ROOT, c)));

  if (missing.length) {
    console.error(`\nFAIL ${name}: ${missing.length} copy/copies missing:`);
    for (const m of missing) console.error(`  ${m}`);
    problems++;
    continue;
  }

  const hashes = new Map();
  for (const c of present) {
    const h = sha(path.join(ROOT, c));
    if (!hashes.has(h)) hashes.set(h, []);
    hashes.get(h).push(c);
  }
  checked += present.length;

  if (hashes.size === 1) {
    console.log(`  ok   ${name.padEnd(24)} ${present.length} copies identical`);
  } else {
    console.error(`\nFAIL ${name}: ${hashes.size} different versions in the tree:`);
    for (const [h, files] of hashes) {
      console.error(`  ${h.slice(0, 12)}  ${files.join(', ')}`);
    }
    console.error(`\nCopy one over the others verbatim and re-run the vectors:`);
    console.error(`  npx tsx scripts/test-parking-tariff.mjs`);
    problems++;
  }
}

// Shared-components (docs/SHARED-COMPONENTS-PLAN.md): a rule that moved to packages/core/src is imported from
// '@zaptill/core/<name>' and has NO copies. A copy growing back (an old branch merged, a file pasted for speed) would be
// a second implementation that nothing keeps in step — so a file of the same name in shared/ or an app's lib/, shared/
// or main/ folder fails, and so does a module that is still listed above.
const CORE_DIR = path.join(ROOT, 'packages', 'core', 'src');
const COPY_DIRS = [
  'shared',
  'apps/server/src/lib', 'apps/server/src/shared',
  'apps/dashboard/src/lib',
  'apps/admin/src/lib',
  'apps/desktop/src/main', 'apps/desktop/src/shared',
];
// Documented exceptions: a DIFFERENT module that only shares a core module's name (decided 2026-10-28, shared-components
// batch C: an exception rather than a rename). Each holds only while that file stays a different module: it must not
// equal the core file, must not define any name of the listed kinds that the core module exports, and must still carry
// its own marks — the code that makes it a different module. A real copy pasted there fails as any other.
const DIFFERENT_MODULE = {
  // The till's own A588 pump counters — litres today per pump and per grade, the last sale, the tanks' levels — read
  // from this till's SQLite; packages/core/src/forecourt.ts is the pumps screens' rules (grade colours, the fuel keypad,
  // the gauges). No name in common at all.
  'apps/desktop/src/main/forecourt.ts': {
    kinds: 'const|function|type|interface',
    marks: [/^import \{[^}]*\bgetLocalDb\b[^}]*\} from '\.\/localDb';$/m, /\bgetLocalDb\(\)/],
  },
  // Batch D (2026-10-30): the cloud's own shift-confirmation rules (who may confirm, from the approver row and the
  // effective keys; the confirm view's lines); packages/core/src/shiftConfirm.ts is the till's and the web's screens'
  // rules. They share one TYPE name (CashBreakdown, the same four cash lines), so only values count here.
  'apps/server/src/lib/shiftConfirm.ts': {
    kinds: 'const|function',
    marks: [/^import \{[^}]*\} from '\.\/approver';$/m, /^import \{[^}]*\bkeysForRow\b[^}]*\} from '\.\/effectiveKeys';$/m],
  },
};
const isDifferentModule = (rel, src, core) => {
  const d = DIFFERENT_MODULE[rel];
  if (!d) return false;
  const exported = [...core.matchAll(new RegExp(`^export\\s+(?:async\\s+)?(?:${d.kinds})\\s+(\\w+)`, 'gm'))].map((m) => m[1]);
  const defines = (n) => new RegExp(`^export\\s+(?:async\\s+)?(?:${d.kinds})\\s+${n}\\b`, 'm').test(src);
  return src !== core && exported.length > 0 && !exported.some(defines) && d.marks.every((re) => re.test(src));
};
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const coreModules = fs.existsSync(CORE_DIR) ? fs.readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts')) : [];
for (const mod of coreModules) {
  const present = COPY_DIRS.map((d) => `${d}/${mod}`).filter((c) => fs.existsSync(path.join(ROOT, c)));
  const different = present.filter((c) => isDifferentModule(c, text(c), text(`packages/core/src/${mod}`)));
  const regrown = present.filter((c) => !different.includes(c));
  const listed = SHARED.some((e) => e.name === mod);
  if (regrown.length || listed) {
    console.error(`\nFAIL ${mod} lives in packages/core/src — import it as '@zaptill/core/${mod.replace(/\.ts$/, '')}', do not copy it:`);
    for (const c of regrown) console.error(`  delete ${c}`);
    if (listed) console.error(`  remove its entry from SHARED in scripts/check-shared-sync.mjs`);
    problems++;
  } else {
    console.log(`  ok   ${mod.padEnd(24)} packages/core only (no copies)${different.length ? ` — ${different.join(', ')} is a different module (DIFFERENT_MODULE)` : ''}`);
  }
}

// …and only by its package name. A relative import ('../../../packages/core/src/x') type-checks and even builds, but the
// cloud's and the desktop main process's compiled code would then require a path outside the app: not shipped in the
// installer's app.asar, not present on Render. The bundlers would inline it, so the rule is the same everywhere.
const APP_SRC = ['apps/server/src', 'apps/dashboard/src', 'apps/admin/src', 'apps/desktop/src'];
const RELATIVE_CORE = /(?:from\s+|import\(\s*|require\(\s*)['"](?:\.\.?\/)+(?:[^'"]*\/)?packages\/core\b/;
const walkSrc = (d, out = []) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkSrc(p, out); else if (/\.(tsx?|mjs|cjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
};
for (const dir of APP_SRC) {
  for (const f of walkSrc(path.join(ROOT, dir))) {
    if (RELATIVE_CORE.test(fs.readFileSync(f, 'utf8'))) {
      console.error(`\nFAIL ${path.relative(ROOT, f)} imports packages/core by a relative path — use '@zaptill/core/<name>'.`);
      problems++;
    }
  }
}

// The check's own failure mode is finding nothing and declaring success.
if (checked === 0) {
  console.error('\nrefusing to pass: no shared files were found at all. Check the paths in SHARED.');
  process.exit(2);
}

if (problems) {
  console.error(`\n${problems} shared file(s) out of sync.\n`);
  process.exit(1);
}

console.log(`\nOK — ${checked} shared file copies all agree.`);
