// A515 + A516 (owner, 2026-10-16).
//   A515 — the 1.0.17 PR's CI failed on lan-tls (flaky ~1 in 6 here): after the branch server restarted, a till's next
//   request went out on a kept connection the server had already closed, failed as EPROTO / a reset, and was read as
//   "the branch server does not answer encrypted" (tls_failed). With A508 servers restart by themselves for updates, so
//   this was a real shop problem, not only a test one. pinnedFetch now drops that pool's idle connections and asks once
//   more on a fresh one; identity / certificate refusals are never retried.
//   A516 — "add the items you have proposed": the low-memory graphics mode (A513) set from the Tech page (Auto / On /
//   Off), not by editing gpu-mode.json by hand.
//
//   cd apps/desktop && npm run build:main && node --no-warnings test/tls-reuse-gpu-a515.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

console.log('\nA515 — a closed kept connection is asked again; A516 — the graphics switch\n');
const t = src('src/main/lanTls.ts');
ok('A515: a request that failed on a REUSED connection is asked once more, on a fresh one', () => {
  assert.match(t, /if \(!retried && \(req as any\)\.reusedSocket && !signal\?\.aborted && !settled\) \{/);
  assert.match(t, /for \(const list of Object\.values\(pool\.freeSockets \?\? \{\}\)\) for \(const s of \(list as any\[\]\) \?\? \[\]\) \{ try \{ s\.destroy\(\); \}/);
  assert.match(t, /attempt\(true\)\.then\(resolve, reject\);/);
  assert.match(t, /return await attempt\(false\);/);
});
ok('A515: identity and certificate refusals come BEFORE the retry (never retried)', () => {
  const i = t.indexOf('if (e instanceof NodeIdentityError || CERT_ERRORS.has');
  const r = t.indexOf('if (!retried && (req as any).reusedSocket');
  assert.ok(i > 0 && r > i, `identity check at ${i}, retry at ${r}`);
});
const h = src('src/main/ipcHandlers.ts');
ok('A516: the graphics mode is read and set only with a technician session, as auto / on / off', () => {
  assert.match(h, /handle\('tech:getGpuMode'[\s\S]{0,120}if \(!getActiveSession\(\)\) throw/);
  assert.match(h, /handle\('tech:setGpuMode'[\s\S]{0,260}if \(!getActiveSession\(\)\) throw[\s\S]{0,200}mode !== 'auto' && mode !== 'on' && mode !== 'off'/);
});
ok('A516: it writes the same file the start gate reads (gpu-mode.json in the data folder)', () => {
  assert.match(h, /path\.join\(app\.getPath\('userData'\), 'gpu-mode\.json'\)/);
  assert.match(src('src/main/startGate.ts'), /export const GPU_MODE_FILE = 'gpu-mode\.json';/);
});
ok('A516: the Tech page shows the three choices and says it takes effect at the next start', () => {
  const p = src('src/renderer/components/UpdateDiagnosticsPanel.tsx');
  assert.match(p, /data-testid="gpu-mode"/);
  assert.match(p, /\['auto', 'on', 'off'\] as const/);
  assert.match(p, /takes effect when ZapTill next starts/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
