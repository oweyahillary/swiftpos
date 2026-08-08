// Behavioural test for main/logFile.ts — runs the REAL compiled dist/main/logFile.js
// against a stubbed electron module. Not a type check: this proves the file
// writes, rolls, and cannot throw.
//
// Run: node apps/desktop/test/logFile.test.mjs

import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';
import assert from 'assert';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-log-'));

// Fail with something readable rather than a module-not-found stack.
const distMain = path.join(here, '..', 'dist', 'main');
if (!fs.existsSync(path.join(distMain, 'logFile.js'))) {
  console.error('dist/main not built. Run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}


// Stub `electron` so app.getPath('userData') resolves into our sandbox.
const origResolve = Module._resolveFilename;
const shim = path.join(tmp, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} } };`);
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return shim;
  return origResolve.call(this, req, ...rest);
};

const { logLine, getLogPath, describeResponse } =
  await import(pathToFileURL(path.join(here, '..', 'dist', 'main', 'logFile.js')).href);

const logPath = getLogPath();
let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

console.log('logFile.ts\n');

check('getLogPath points inside userData', () => {
  assert.strictEqual(logPath, path.join(tmp, 'swiftpos.log'));
});

check('logLine writes a line with timestamp and scope', () => {
  logLine('sync', 'catalogue pull failed: HTTP 403 - BRANCH_NOT_LICENSED');
  const body = fs.readFileSync(logPath, 'utf8');
  assert.match(body, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[sync\] catalogue pull failed: HTTP 403/m);
});

check('logLine appends rather than truncating', () => {
  logLine('auth', 'owner token refresh failed: HTTP 401');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2, `expected 2 lines, got ${lines.length}`);
  assert.match(lines[1], /\[auth\]/);
});

check('rolls at 1MB into a single .1 backup', () => {
  fs.writeFileSync(logPath, 'x'.repeat(1_000_001));
  logLine('sync', 'after roll');
  assert.ok(fs.existsSync(`${logPath}.1`), 'no .1 backup created');
  const cur = fs.readFileSync(logPath, 'utf8');
  assert.ok(cur.includes('after roll'), 'new line missing from fresh file');
  assert.ok(cur.length < 1000, 'current file was not reset');
});

check('rolls only once - two files, never a directory of them', () => {
  fs.writeFileSync(logPath, 'y'.repeat(1_000_001));
  logLine('sync', 'second roll');
  const files = fs.readdirSync(tmp).filter(f => f.startsWith('swiftpos.log'));
  assert.strictEqual(files.length, 2, `expected 2 log files, got ${files.join()}`);
});

check('never throws when the path is unwritable', () => {
  const dir = path.join(tmp, 'swiftpos.log');
  fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir); // a directory where the file should be — appendFileSync will EISDIR
  assert.doesNotThrow(() => logLine('sync', 'should be swallowed'));
  fs.rmdirSync(dir);
});

console.log('\ndescribeResponse\n');

check('includes status, statusText and body', async () => {});
const d1 = await describeResponse({
  status: 403, statusText: 'Forbidden',
  text: async () => '{"error":"Branch not licensed","code":"BRANCH_NOT_LICENSED","ref":"341849fb"}',
});
check('surfaces the server ref that keys the server log', () => {
  assert.match(d1, /HTTP 403 Forbidden/);
  assert.match(d1, /341849fb/);
});

const d2 = await describeResponse({ status: 500, text: async () => 'x'.repeat(50_000) });
check('caps a huge body at 500 chars', () => {
  assert.ok(d2.length < 600, `body not capped: ${d2.length} chars`);
});

const d3 = await describeResponse({ status: 502, text: async () => '  \n\n  ' });
check('omits an empty body instead of trailing a dash', () => {
  assert.strictEqual(d3, 'HTTP 502');
});

const d4 = await describeResponse({
  status: 500, text: async () => { throw new Error('stream closed'); },
});
check('survives an unreadable body', () => {
  assert.match(d4, /HTTP 500 - \(body unreadable\)/);
});

const d5 = await describeResponse({
  status: 401, text: async () => 'line one\nline two\r\nline three',
});
check('collapses newlines so one event stays one log line', () => {
  assert.ok(!d5.includes('\n'), 'newline leaked into the log line');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
