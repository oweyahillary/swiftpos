#!/usr/bin/env node
/**
 * SwiftPOS Test Runner
 * Usage: node tests/runner.mjs [options]
 *
 * Options:
 *   --url      Server base URL (default: http://localhost:4000)
 *   --email    Owner email
 *   --password Owner password
 *   --suite    Comma-separated list: auth,data,orders,reports,security,permissions,stress,restaurant,petrol
 *   --stress   Include stress tests
 *   --verbose  Show all pass results
 *   --bail     Stop on first failure
 */

import { parseArgs } from 'node:util';
import { state, counts, failures, setVerbose, BASE_URL } from './lib.mjs';

const { values: args } = parseArgs({
  options: {
    url:      { type: 'string',  default: 'http://localhost:4000' },
    email:    { type: 'string',  default: '' },
    password: { type: 'string',  default: '' },
    suite:    { type: 'string',  default: 'auth,data,orders,reports,security,permissions' },
    stress:   { type: 'boolean', default: false },
    verbose:  { type: 'boolean', default: false },
    bail:     { type: 'boolean', default: false },
  },
  strict: false,
});

// Apply settings to shared lib state
BASE_URL.value = args.url.replace(/\/$/, '');
setVerbose(args.verbose);

const suitesToRun = new Set(args.suite.split(',').map(s => s.trim().toLowerCase()));
if (args.stress) suitesToRun.add('stress');

async function runSuite(name, relPath) {
  if (!suitesToRun.has(name)) return;
  // Use URL API to resolve path — works correctly on Windows (stays in file:// space)
  const suiteUrl = new URL(relPath, import.meta.url).href;
  try {
    const mod = await import(suiteUrl);
    await mod.run();
  } catch (err) {
    console.log(`\n  [${name}] Suite error: ${err.code ?? ''} ${err.message}`);
    console.log(`  ${err.stack?.split('\n')[1] ?? ''}`);
  }
}

function summary() {
  const total = counts.pass + counts.fail + counts.skip + counts.warn;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results: ${counts.pass} passed  ${counts.fail} failed  ${counts.warn} warnings  ${counts.skip} skipped`);
  console.log(`  Total:   ${total} checks`);
  if (failures.length) {
    console.log(`\n  Failed:`);
    failures.forEach(f => console.log(`    ✗  ${f.name}${f.detail ? '  →  ' + f.detail : ''}`));
  }
  console.log('═'.repeat(60));
}

// ── Entry point ───────────────────────────────────────────────────────────────
console.log(`\nSwiftPOS System Test Suite`);
console.log(`Target: ${BASE_URL.value}`);
console.log(`Suites: ${[...suitesToRun].join(', ')}`);
console.log(`\nChecking server health...`);

const health = await fetch(`${BASE_URL.value}/health`).then(r => r.json()).catch(() => null);
if (!health || health.status !== 'ok') {
  console.error(`\n✗ Server not reachable at ${BASE_URL.value}\n  Start it with: pnpm --filter server dev\n`);
  process.exit(1);
}
console.log(`✓ Server up (${health.env ?? 'unknown env'}, ts: ${health.ts})\n`);

if (!args.email || !args.password) {
  console.error('✗ --email and --password are required\n');
  process.exit(1);
}

state.ownerEmail    = args.email;
state.ownerPassword = args.password;

await runSuite('auth',        './suites/auth.mjs');
await runSuite('data',        './suites/data.mjs');
await runSuite('orders',      './suites/orders.mjs');
await runSuite('reports',     './suites/reports.mjs');
await runSuite('security',    './suites/security.mjs');
await runSuite('permissions', './suites/permissions.mjs');
await runSuite('stress',      './suites/stress.mjs');
await runSuite('restaurant',  './suites/restaurant.mjs');
await runSuite('petrol',      './suites/petrol.mjs');

summary();
process.exit(counts.fail > 0 ? 1 : 0);
