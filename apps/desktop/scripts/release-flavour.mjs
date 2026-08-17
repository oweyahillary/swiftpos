#!/usr/bin/env node
/**
 * release-flavour.mjs — run a flavoured desktop release without a
 * cross-platform env-setting dependency (D17).
 *
 * Setting SWIFTPOS_ENV inline (`SWIFTPOS_ENV=dev npm run release:patch`) works
 * in Git Bash but NOT when npm falls back to cmd.exe, so a named npm script
 * would need `cross-env` — an archived package plus a lockfile change (which
 * rule 22 says the delivery must not carry). This wrapper does the same job in
 * ~20 lines we own: it sets SWIFTPOS_ENV in the child's environment and hands
 * off to the existing `release:<bump>` chain, so all the real build logic stays
 * in one place.
 *
 *   node scripts/release-flavour.mjs dev  patch
 *   node scripts/release-flavour.mjs prod minor
 *   node scripts/release-flavour.mjs dev  none    # build at current version, NO bump
 *   FLAVOUR_DRYRUN=1 node scripts/release-flavour.mjs dev patch   # print, don't build
 */
import { spawnSync } from 'node:child_process';

const [flavour = 'prod', bump = 'patch'] = process.argv.slice(2);

if (!['prod', 'dev'].includes(flavour)) {
  console.error(`release-flavour: unknown flavour "${flavour}" — expected prod|dev`);
  process.exit(2);
}
if (!['patch', 'minor', 'major', 'none'].includes(bump)) {
  console.error(`release-flavour: unknown bump "${bump}" — expected patch|minor|major|none`);
  process.exit(2);
}

const env = { ...process.env, SWIFTPOS_ENV: flavour };

// `none` builds at the CURRENT version — no version:patch, no tag. For the dev
// test loop, where a throwaway build shouldn't move the number that only real
// releases (and tags) should touch. Otherwise hand off to the release:<bump> chain.
const steps = bump === 'none'
  ? ['build:all', 'assert:built', 'pack:installer', 'pack:portable']
  : [`release:${bump}`];
const desc = bump === 'none' ? `build:all + dist (no bump)` : `npm run release:${bump}`;
console.log(`[release-flavour] SWIFTPOS_ENV=${flavour} → ${desc}`);

// Dry run: prove the flavour→env mapping without bumping a version or building.
if (process.env.FLAVOUR_DRYRUN) {
  console.log(`[release-flavour] DRY RUN — would run: ${steps.map(s => `npm run ${s}`).join(' && ')} (SWIFTPOS_ENV=${env.SWIFTPOS_ENV})`);
  process.exit(0);
}

for (const s of steps) {
  const r = spawnSync('npm', ['run', s], { stdio: 'inherit', env, shell: true });
  if (r.status !== 0) { console.error(`[release-flavour] FAILED at: npm run ${s}`); process.exit(r.status ?? 1); }
}
process.exit(0);
