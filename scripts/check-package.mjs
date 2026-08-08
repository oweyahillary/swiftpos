#!/usr/bin/env node
/**
 * check-package — prove the release archive carries no secrets.
 *
 * WHY THIS IS NOT A SHELL ONE-LINER
 * ---------------------------------
 * It was, and on 2026-08-08 it printed "clean" without running. `git archive`
 * failed to write to /tmp under Git Bash on Windows, and the `|| echo "clean"`
 * fallback swallowed the failure and reported success. A check that passes when
 * it did not run is worse than no check: it is the false confidence that let
 * .env ride along in pos.zip five handoffs running (register A1).
 *
 * So: real exit codes, an explicit assertion that the archive was actually
 * produced, and a temp path from os.tmpdir() rather than a POSIX literal.
 *
 * Run:  npm run package:check
 * Exit: 0 clean · 1 something is in the archive that must not be · 2 could not check
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, existsSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Anything matching these must never reach a client machine.
const FORBIDDEN = [
  // .env.example is a template by design and carries no values.
  { re: /(^|\/)\.env(?!\.example$)($|\.)/i, why: 'environment file - may hold SUPABASE_SERVICE_ROLE_KEY' },
  { re: /(^|\/)node_modules\//i,     why: 'dependency tree' },
  { re: /\.(pem|key|p12|pfx)$/i,     why: 'private key or certificate' },
  { re: /(^|\/)\.git\//i,            why: 'git internals' },
  { re: /\.(db|sqlite3?)$/i,         why: 'database file - may hold live tokens' },
];

const work = mkdtempSync(join(tmpdir(), 'swiftpos-pkgcheck-'));
const archive = join(work, 'pos-check.zip');

function bail(code, msg) {
  console.error(msg);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
}

// 1. Build the archive. A failure here is exit 2 — unknown, not clean.
try {
  execFileSync('git', ['archive', '--format=zip', 'HEAD', '-o', archive], { stdio: 'pipe' });
} catch (err) {
  bail(2, `could not build the archive, so nothing was checked:\n  ${err.stderr?.toString().trim() || err.message}`);
}

// 2. Prove it exists and is not empty. The old version never did this, which is
//    precisely how it reported clean on an archive that was never written.
if (!existsSync(archive) || statSync(archive).size === 0) {
  bail(2, 'git archive reported success but produced no file - nothing was checked');
}

// 3. List what the archive contains. `git archive HEAD` ships exactly the
//    tracked paths at HEAD, so ls-tree IS the manifest - no unzip dependency and
//    no guessing. The first version of this scraped printable strings out of the
//    tar payload and matched file CONTENTS, reporting 188 leaks in a clean tree.
//    A check that cries wolf gets ignored, which is the same failure as one that
//    stays silent.
let entries;
try {
  entries = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\n').map(s => s.trim()).filter(Boolean);
} catch (err) {
  bail(2, `could not list the archive contents: ${err.message}`);
}
if (entries.length === 0) bail(2, 'HEAD lists no files - nothing was checked');

const hits = [];
for (const name of entries) {
  for (const { re, why } of FORBIDDEN) {
    if (re.test(name)) hits.push(`${name}  (${why})`);
  }
}

if (hits.length) {
  bail(1, `LEAK - do not ship. ${hits.length} forbidden entr${hits.length === 1 ? 'y' : 'ies'}:\n` +
          [...new Set(hits)].map(h => `  * ${h}`).join('\n'));
}

console.log(`clean - ${entries.length} paths scanned, nothing forbidden`);
rmSync(work, { recursive: true, force: true });
