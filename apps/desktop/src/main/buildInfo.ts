/**
 * buildInfo.ts — A298. Reads the build stamp that gen-build-info.mjs writes next
 * to the compiled main (dist/main/build-info.json). Committed source, runtime
 * data: the JSON is generated at build and gitignored (under dist), so this file
 * never needs regenerating and a bare tsc never breaks on a missing import.
 *
 * Falls back to 'unknown' when the stamp is absent (a dev `tsc` watch that never
 * ran the generator, or an old build) — never throws.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildInfo { sha: string; time: string }

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    const raw = readFileSync(join(__dirname, 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    cached = { sha: parsed.sha || 'unknown', time: parsed.time || 'unknown' };
  } catch {
    cached = { sha: 'unknown', time: 'unknown' };
  }
  return cached;
}
