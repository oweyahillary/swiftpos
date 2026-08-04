#!/usr/bin/env node
/**
 * Phase 3 — the office role and the promotion lever. Wiring-heavy phase, so
 * source-pinned throughout: every assertion names a rule that, silently
 * violated, produces a machine in the wrong role doing cash-bearing work.
 *
 * What must hold:
 *   1. One vocabulary: isNodeRole ("serves the branch") and canSell answer
 *      every role question. Raw === 'node' comparisons are how office
 *      machines fall through cracks.
 *   2. An office machine SERVES: listener, ingest, distribution, snapshots,
 *      branch-wide reports, Close Branch — and does NOT poll itself.
 *   3. An office machine CANNOT SELL, refused in MAIN (shift open + order
 *      create), not merely hidden in the renderer.
 *   4. The promotion lever: session-gated, audited, and repointing PROBES
 *      before saving — a wrong address written blind is a till that silently
 *      stops replicating. A repointed former node steps down and stops
 *      serving.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, extra='') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DC = read('apps/desktop/src/main/deviceConfig.ts');
const IX = read('apps/desktop/src/main/index.ts');
const NS = read('apps/desktop/src/main/nodeServer.ts');
const NC = read('apps/desktop/src/main/nodeClient.ts');
const MT = read('apps/desktop/src/main/maintenance.ts');
const SS = read('apps/desktop/src/main/shiftService.ts');
const SE = read('apps/desktop/src/main/syncEngine.ts');
const IH = read('apps/desktop/src/main/ipcHandlers.ts');
const MR = read('apps/desktop/src/main/managerReports.ts');
const DR = read('apps/desktop/src/main/dailySalesReport.ts');
const PA = read('apps/desktop/src/renderer/lib/posApi.ts');
const IP = read('apps/desktop/src/renderer/pages/InstallPage.tsx');
const BC = read('apps/desktop/src/renderer/pages/BranchCloseTab.tsx');

console.log('\n1. One vocabulary for roles');
{
  ok("DeviceRole includes 'office' on both sides",
     DC.includes("'till' | 'node' | 'office'") && PA.includes("'till' | 'node' | 'office'"));
  ok('isNodeRole = node OR office', /isNodeRole[\s\S]{0,200}role === 'node' \|\| role === 'office'/.test(DC));
  ok("canSell = everything except office", /canSell[\s\S]{0,120}role !== 'office'/.test(DC));
  // The rule that keeps the vocabulary honest: outside deviceConfig, no main
  // module compares device_role to the literal 'node' for a SERVES question.
  const serves = [['index.ts', IX], ['nodeServer.ts', NS], ['nodeClient.ts', NC], ['maintenance.ts', MT]];
  for (const [name, src] of serves) {
    ok(`${name} asks isNodeRole, not === 'node'`,
       src.includes('isNodeRole(') && !/device_role [!=]== 'node'/.test(src));
  }
}

console.log('\n2. An office machine serves the branch');
{
  ok('the listener starts for node OR office', /if \(!isNodeRole\(cfg\?\.device_role\)\) return;/.test(NS));
  ok('boot starts the server via isNodeRole', /if \(isNodeRole\(cfg\?\.device_role\)\) startNodeServer\(\)/.test(IX));
  ok('instruction poll excludes ALL serving roles (no self-poll)',
     /pendingAcks\]\) \{[\s\S]{0,120}/.test(IX) ? /isNodeRole\(cfg\.device_role\)\) return;[\s\S]{0,900}pollNodeInstructions/.test(IX) : false);
  ok('distribution pull excludes ALL serving roles',
     /isNodeRole\(cfg\.device_role\)\) return;[\s\S]{0,600}pullNodeDistribution/.test(IX));
  ok('snapshots run on any serving role', /isNodeRole\(getDeviceConfig\(\)\?\.device_role\)\) return null;/.test(MT));
  ok('pruning skips any serving role — it is the archive', /isNodeRole\(cfg\?\.device_role\)\) \{[\s\S]{0,150}archive/.test(MT));
  ok('branch-wide reports for any serving role',
     MR.includes("isNodeRole(cfg?.device_role) ? 'node'") && DR.includes('isNodeRole(cfg?.device_role)'));
  ok('Close Branch screen accepts office', BC.includes("role !== 'node' && role !== 'office'"));
  ok('install screen offers the third role', IP.includes("roleBtn('office'"));
}

console.log('\n3. An office machine cannot sell — refused in MAIN');
{
  ok('openShift refuses via canSell', /openShift[\s\S]{0,500}canSell\(getDeviceConfig\(\)\?\.device_role\)[\s\S]{0,200}no cash drawer/.test(SS));
  ok('createLocalOrder refuses via canSell', /createLocalOrder[\s\S]{0,400}canSell\(getDeviceConfig\(\)\?\.device_role\)[\s\S]{0,200}cannot ring sales/.test(SE));
}

console.log('\n4. The promotion lever');
{
  ok('promote is session-gated', /tech:promoteToNode[\s\S]{0,200}getActiveSession\(\)\) return \{ ok: false/.test(IH));
  ok('promote is audited with from/to', /logTechAction\('role\.promote', \{ from: before, to: 'node' \}\)/.test(IH));
  ok('promotion clears node_url and starts serving immediately',
     /saveDeviceConfig\(\{ device_role: 'node', node_url: null \}\);\s*startNodeServer\(\)/.test(IH));
  ok('the branch access code is returned for the tech to read', /const secret = ensureNodeSecret\(\)/.test(IH));
  ok('repoint is session-gated and audited',
     /tech:setNodeUrl[\s\S]{0,200}getActiveSession\(\)[\s\S]{0,300}logTechAction\('role\.repoint'/.test(IH));
  ok('repoint PROBES before saving', /const probe = await probeNode[\s\S]{0,120}if \(!probe\.ok\) return/.test(IH));
  ok('a repointed former node steps down AND stops serving',
     /was === 'node'\) stopNodeServer\(\)/.test(IH) && /device_role: was === 'node' \? 'till' : was/.test(IH));
  ok('probeNode distinguishes refused-code from no-answer',
     NC.includes('refused this till') && NC.includes('No branch server answered'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
