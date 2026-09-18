#!/usr/bin/env node
/**
 * gen-build-info.mjs — A298. Stamp the build with its git SHA + build time so a
 * till can SAY which commit it is running (the provenance the 0.5.44/0.5.45 mix-ups
 * made the case for: a build missing an intended change looked identical to one
 * that had it).
 *
 * Writes dist/main/build-info.json, read at runtime by src/main/buildInfo.ts and
 * shown on the Tech screen + logged on launch. Runs after build:main (dist/main
 * exists) as a step of build:all. It NEVER exits non-zero: a missing git or a
 * write failure falls back to a placeholder rather than breaking the release
 * chain — an unknown stamp is a minor loss, a broken build is not.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'dist', 'main', 'build-info.json');

function shortSha() {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    const s = (r.stdout || '').trim();
    if (s) return s;
  } catch { /* fall through */ }
  const env = process.env.GITHUB_SHA;
  if (env) return env.slice(0, 7);
  return 'unknown';
}

const info = { sha: shortSha(), time: new Date().toISOString() };

try {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(info) + '\n');
  console.log(`[gen-build-info] ${info.sha} @ ${info.time}`);
} catch (err) {
  console.warn('[gen-build-info] could not write build-info.json:', err?.message ?? err);
}
process.exit(0);
