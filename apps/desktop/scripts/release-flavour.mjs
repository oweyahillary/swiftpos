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
 *   FLAVOUR_DRYRUN=1 node scripts/release-flavour.mjs dev patch   # print, don't build
 */
import { spawnSync } from 'node:child_process';

const [flavour = 'prod', bump = 'patch'] = process.argv.slice(2);

if (!['prod', 'dev'].includes(flavour)) {
  console.error(`release-flavour: unknown flavour "${flavour}" — expected prod|dev`);
  process.exit(2);
}
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`release-flavour: unknown bump "${bump}" — expected patch|minor|major`);
  process.exit(2);
}

const env = { ...process.env, SWIFTPOS_ENV: flavour };
const cmd = `npm run release:${bump}`;
console.log(`[release-flavour] SWIFTPOS_ENV=${flavour} → ${cmd}`);

// Dry run: prove the flavour→env mapping without bumping a version or building.
if (process.env.FLAVOUR_DRYRUN) {
  console.log(`[release-flavour] DRY RUN — would run: ${cmd} (SWIFTPOS_ENV=${env.SWIFTPOS_ENV})`);
  process.exit(0);
}

const r = spawnSync('npm', ['run', `release:${bump}`], { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
