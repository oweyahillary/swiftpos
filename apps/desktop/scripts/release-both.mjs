#!/usr/bin/env node
/**
 * release-both.mjs — build BOTH desktop flavours (prod + dev) at ONE version (D17).
 *
 * Running `release:patch` then `release:patch:dev` bumps the version TWICE, so
 * the two installers come out at different numbers (0.5.29 vs 0.5.30). That is
 * the "version build-up" — two npm-version calls for what is one release.
 *
 * This bumps once (or not at all), builds the flavour-INDEPENDENT bundle once,
 * then packs each flavour from that single build. The renderer and main bundles
 * are identical between flavours — the flavour only changes electron-builder's
 * metadata (icon, appId, productName) at pack time — so building once and
 * packing twice is correct AND faster than two full releases.
 *
 *   node scripts/release-both.mjs            # bump patch once, build prod + dev
 *   node scripts/release-both.mjs minor      # bump minor once, build both
 *   node scripts/release-both.mjs none       # NO bump — both at the current version
 *   FLAVOUR_DRYRUN=1 node scripts/release-both.mjs   # print the plan, run nothing
 *
 * Output (apps/desktop/release/), all at the same version V:
 *   SwiftPOS-V-x64.exe          SwiftPOS-V-portable.exe        (prod)
 *   SwiftPOS Dev-V-x64.exe      SwiftPOS-Dev-V-portable.exe    (dev)
 */
import { spawnSync } from 'node:child_process';

const bump = process.argv[2] || 'patch';
const BUMPS = ['patch', 'minor', 'major', 'none'];
if (!BUMPS.includes(bump)) {
  console.error(`release-both: bump must be one of ${BUMPS.join('|')} — got "${bump}"`);
  process.exit(2);
}

const dry = !!process.env.FLAVOUR_DRYRUN;

function run(args, env) {
  const tag = env?.SWIFTPOS_ENV ? `  (SWIFTPOS_ENV=${env.SWIFTPOS_ENV})` : '';
  console.log(`[release-both] npm run ${args.join(' ')}${tag}`);
  if (dry) return;
  const r = spawnSync('npm', ['run', ...args], { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`[release-both] FAILED at: npm run ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

// 1. bump the version ONCE — the whole point: both apps share this number.
if (bump !== 'none') run([`version:${bump}`]);
else console.log('[release-both] no version bump (both flavours at the current version)');

// 2. build the flavour-independent bundle ONCE (clean + tsc main + vite renderer).
run(['build:all']);
run(['assert:built']);

// 3. pack each flavour from that single build, at that single version.
for (const flavour of ['prod', 'dev']) {
  run(['pack:installer'], { SWIFTPOS_ENV: flavour });
  run(['pack:portable'], { SWIFTPOS_ENV: flavour });
}

console.log('[release-both] done — prod + dev packaged at one version. Artifacts in apps/desktop/release/.');
