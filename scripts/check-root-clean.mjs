/**
 * check-root-clean.mjs — A172. Enforces rule 19: "Nothing but README.md in the
 * repo root. Documents live in docs/."
 *
 * The rule exists because "~140 stray zips" accumulated in the root and a stale
 * file there gets read as current. This gate flags the exact failure mode: a
 * document (`.md` other than README.md), an archive (`.zip`), or a delivery
 * patch (`.patch`/`.diff`) sitting in the repo root. It deliberately does NOT
 * touch build/config that legitimately lives in root (package.json, render.yaml,
 * rearm-till.mjs, dotfiles) — rule 19 is about documents and archives, not code.
 *
 * `--self-test` (rule 23): proves the classifier flags a stray root doc/zip/patch
 * and clears README.md and legitimate config, using the same predicate the real
 * run uses (rule 24).
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** True if a root-level filename violates rule 19. Pure, so the self-test can drive it. */
export function isStrayRootDoc(name) {
  if (name === 'README.md') return false;
  return /\.(md|zip|patch|diff)$/i.test(name);
}

function selfTest() {
  const cases = [
    ['README.md', false],
    ['MANIFEST-2026-08-27-e.md', true],
    ['swiftpos-2026-08-27-c.patch', true],
    ['old-notes.diff', true],
    ['bundle.zip', true],
    ['package.json', false],
    ['render.yaml', false],
    ['rearm-till.mjs', false],
    ['.gitignore', false],
  ];
  let ok = 0, bad = 0;
  for (const [name, want] of cases) {
    if (isStrayRootDoc(name) === want) { ok++; console.log(`  ok  ${name} → ${want}`); }
    else { bad++; console.log(`FAIL  ${name} — expected ${want}`); }
  }
  console.log(`\ncheck-root-clean self-test: ${ok} passed, ${bad} failed`);
  return bad === 0;
}

if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1);
}

const stray = readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isFile() && isStrayRootDoc(d.name))
  .map(d => d.name)
  .sort();

if (stray.length) {
  console.error('Rule 19 — the repo root must hold no documents/archives but README.md.\n'
    + 'Move these into docs/ (or delete a superseded delivery artifact):\n');
  for (const f of stray) console.error(`  ${f}`);
  process.exit(1);
}
console.log('OK — repo root is clean (only README.md among docs/archives).');
