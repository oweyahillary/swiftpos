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
    name: 'parkingTariff.ts',
    copies: [
      'shared/parkingTariff.ts',
      'apps/server/src/shared/parkingTariff.ts',
      'apps/desktop/src/shared/parkingTariff.ts',
    ],
  },
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
