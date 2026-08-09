// Run a test file under Electron-as-Node.
//
// WHY: apps/desktop's postinstall runs `electron-builder install-app-deps`,
// which rebuilds native modules — better-sqlite3 among them — against ELECTRON's
// ABI, not the system Node's. So `node test/foo.mjs` cannot load better-sqlite3
// on a normal working install, and on Node < 22.5 there is no node:sqlite to
// fall back to either. Under Electron both problems disappear: it is the same
// binary, ABI and driver the till runs.
//
// Env vars cannot be set inline in an npm script cross-platform without adding
// cross-env, and a dependency is a poor trade for one variable — hence this.
//
// Usage:  node test/run-under-electron.mjs test/heldOrders.test.mjs

import { spawn } from 'child_process';
import { createRequire } from 'module';

const target = process.argv[2];
if (!target) {
  console.error('usage: node test/run-under-electron.mjs <test-file>');
  process.exit(2);
}

let electronPath;
try {
  electronPath = createRequire(import.meta.url)('electron');
} catch {
  console.error(
    'electron is not installed here.\n' +
    '  Run `npm install` in apps/desktop, or run the test under plain node:\n' +
    `    node ${target}   (needs Node >= 22.5 for the node:sqlite stand-in)`);
  process.exit(1);
}

const child = spawn(electronPath, [target], {
  // ELECTRON_RUN_AS_NODE makes the Electron binary behave as a Node runtime —
  // no window, no app lifecycle, just the script.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});

child.on('exit', code => process.exit(code ?? 1));
child.on('error', err => {
  console.error(`could not start electron: ${err.message}`);
  process.exit(1);
});
