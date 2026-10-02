/**
 * fleet-identity.test.mjs — A184 Tier 1 (fleet identity) + Tier 2 (active session).
 *
 * The Terminals screen showed every till as an indistinguishable row (label +
 * version + sync time). Tier 1 surfaces the identity already on user_devices —
 * terminal code, role, branch, MAC — so two rows for one shop are tellable apart
 * and a reinstalled duplicate is visible by its MAC. Tier 2 joins the OPEN shift
 * per device so the fleet shows who is currently trading.
 *
 * Source-level; mutation-checkable.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(root, 'apps/server/src/routes/devices.ts'), 'utf8');
const page   = fs.readFileSync(path.join(root, 'apps/dashboard/src/pages/FleetPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n       ${e.message}`); }
};

// ── Tier 1: server surfaces the identity columns ──
ok('server: /fleet selects the identity columns', () => {
  assert.match(server, /terminal_code, device_role, branch_id, mac_address/,
    'the fleet select must add terminal_code, device_role, branch_id, mac_address');
});

ok('server: fleet rows expose identity to the client', () => {
  assert.match(server, /terminalCode: d\.terminal_code/, 'must map terminalCode');
  assert.match(server, /role:\s*d\.device_role/, 'must map role');
  assert.match(server, /mac:\s*d\.mac_address/, 'must map mac');
  assert.match(server, /branchName:\s*d\.branch_id \?/, 'must resolve branchName from the branch map');
});

// ── Tier 2: server joins the open shift ──
ok('server: active session joins the OPEN shift by device', () => {
  assert.match(server, /\.from\('shifts'\)[\s\S]*?\.in\('device_id', deviceIds\)[\s\S]*?\.eq\('status', 'open'\)/,
    'must query open shifts scoped to this fleet\'s device ids');
  assert.match(server, /activeShift:\s*\(d\.device_id && shiftByDevice\[d\.device_id\]\)/,
    'each fleet row must expose its active shift (or null)');
});

// ── client ──
ok('client: FleetDevice carries the new fields', () => {
  assert.match(page, /terminalCode: string \| null;/, 'type must include terminalCode');
  assert.match(page, /activeShift: \{ cashier: string \| null; openedAt: string \| null \} \| null;/,
    'type must include activeShift');
});

ok('client: renders an On shift column driven by activeShift', () => {
  assert.match(page, /'Terminal', 'On shift'/, "the table must have an 'On shift' column");
  assert.match(page, /d\.activeShift \?/, 'the cell must render off activeShift');
});

ok('client: shows terminal code + MAC to tell tills apart', () => {
  assert.match(page, /d\.terminalCode/, 'the terminal cell must show the terminal code');
  assert.match(page, /d\.mac &&/, 'the terminal cell must show the MAC when present');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
