/**
 * a542-tech-page.test.mjs — A542: small tidy-ups on the till's Tech page, and dead code removed.
 *
 *   node tests/a542-tech-page.test.mjs
 *
 * The behaviour is driven for real in apps/desktop/test/branch-drawers-a535.test.mjs (drawersStatus: the last poll, the
 * drawers held, the tills that asked this hour, the push line, the fallback) and live-sync-a531.test.mjs (the push line's
 * "connected since", last ring, fallback interval). This pins the wiring a technician sees:
 *   - node:drawersStatus — technician or settings.business only, a branch server only; bridged (preload, posApi)
 *   - DrawersCopyPanel on a branch server's Tech page, next to A534's distribution panel
 *   - the Tech/Sync block's push line (A531 liveSync status)
 *   - components/ReceiptView.tsx deleted (imported by nothing since 0.6.29)
 *
 * MUTATIONS TO CONFIRM BITE: the gate dropped from node:drawersStatus → "gate" fails; the panel not mounted → "mounted"
 * fails; the push line removed → "push line" fails; ReceiptView.tsx restored → "dead receipt" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcHandlersSource } from '../scripts/lib/ipc-handler-files.mjs';   // D10: ipcHandlers.ts + ipc/*.ts

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const ipc = ipcHandlersSource();
const tech = r('apps/desktop/src/renderer/pages/TechPage.tsx');
const panel = r('apps/desktop/src/renderer/components/DrawersCopyPanel.tsx');

ok('node:drawersStatus: a technician or settings.business, a branch server only, answers drawersStatus()', () => {
  assert.match(ipc, /handle\('node:drawersStatus', async \(\) => \{\s*if \(!getActiveSession\(\) && !signedInCan\('settings\.business'\)\) throw/);
  assert.match(ipc, /if \(!isNodeRole\(getDeviceConfig\(\)\?\.device_role\)\) return \{ role: 'not_server' as const \};\s*return \{ role: 'server' as const, status: drawersStatus\(\) \};/);
});
ok('bridged: preload, the payload schema and posApi', () => {
  assert.match(r('apps/desktop/src/main/preload.ts'), /drawersStatus: \(\)\s*=> ipcRenderer\.invoke\('node:drawersStatus'\)/);
  assert.match(r('apps/desktop/src/main/ipcSchemas.ts'), /'node:drawersStatus':\s*NO_PAYLOAD/);
  assert.match(r('apps/desktop/src/renderer/lib/posApi.ts'), /drawersStatus: \(\) => Promise<ServerDrawers>;/);
});
ok('the panel is mounted on a branch server\'s Tech page, next to the distribution panel', () => {
  assert.match(tech, /<ServerDistributionPanel \/>\}\s*\{\/\*[^*]*\*\/\}\s*\{\(dev\?\.device_role === 'node' \|\| dev\?\.device_role === 'office'\) && <DrawersCopyPanel \/>\}/);
});
ok('the panel shows the last poll (ok / failed), drawers held, tills this hour, the push line and the fallback', () => {
  assert.match(panel, /s\.lastPollOk \? 'ok' : 'failed'/);
  assert.match(panel, /\{s\.open\} open, \{s\.awaitingConfirmation\} waiting for a confirmation · \{s\.peersLastHour\} till\(s\) asked in the last hour/);
  assert.match(panel, /s\.channel === 'push'/);
  assert.match(panel, /\{s\.fallback && \(/);
});
ok('the Tech/Sync block\'s push line: connected since, last ring, the fallback interval', () => {
  assert.match(tech, /data-testid="tech-push-line"/);
  assert.match(tech, /connected since \$\{new Date\(sync\.live\.push\.since\)\.toLocaleString\(\)\}/);
  assert.match(tech, /last ring: \$\{sync\.live\.push\.lastRingAt/);
  assert.match(tech, /checking every \$\{sync\.live\.push\.fallbackEveryS/);
});
ok('the dead receipt: components/ReceiptView.tsx is gone and nothing in the desktop imports it', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'apps/desktop/src/renderer/components/ReceiptView.tsx')));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const hits = walk(path.join(ROOT, 'apps/desktop/src')).filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /from ['"][^'"]*\/ReceiptView['"]|import\(['"][^'"]*\/ReceiptView['"]\)/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
