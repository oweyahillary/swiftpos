/**
 * A22 — split-brain (two branch servers on one branch) is now said LOUDLY.
 *
 * Detection already existed server-side (confirmServingRole / migration 74 records
 * role_conflict_at). This pins the two surfaces added for A22: the promotion-time
 * probe (refuse while the old node still answers) and the fleet view exposing the
 * recorded conflict. SOURCE-ASSERTION (Electron/browser can't run here, rule 16);
 * the live two-node scenario is target-only. Mutation-checked (rules 10, 23).
 */
import assert from 'node:assert';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');
const IPC   = 'apps/desktop/src/main/ipcHandlers.ts';
const DEV   = 'apps/server/src/routes/devices.ts';
const FLEET = 'apps/dashboard/src/pages/FleetPage.tsx';
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('A22: promotion refuses while the current node is still reachable', () => {
  const s = r(IPC);
  const h = /handle\('tech:promoteToNode'[\s\S]*?saveDeviceConfig\(\{ device_role: 'node'/.exec(s);
  assert.ok(h, 'promoteToNode handler not found');
  const body = h[0];
  // the probe must happen BEFORE the role flip
  assert.match(body, /const probe = await probeNode\(currentNodeUrl\)/);
  assert.match(body, /if \(probe\.ok\) \{[\s\S]{0,220}code: 'node_reachable'/);
  assert.match(body, /return \{[\s\S]{0,260}node_reachable[\s\S]{0,260}\};/);
});

ok('A22: /fleet selects and exposes the recorded conflict', () => {
  const s = r(DEV);
  assert.match(s, /role_conflict_at, role_conflict_with,/);        // selected
  assert.match(s, /servingConflict: !!d\.role_conflict_at/);        // exposed
  assert.match(s, /conflictAt:\s+d\.role_conflict_at/);
});

ok('A22: the fleet view shows a loud split-brain badge', () => {
  const s = r(FLEET);
  assert.match(s, /servingConflict\?: boolean/);                    // type carries it
  assert.match(s, /d\.servingConflict &&/);                         // conditional render
  assert.match(s, /Split-brain/);                                   // the loud text
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
