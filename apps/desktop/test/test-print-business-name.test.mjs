// A322 — the technician test print and the Printers-screen preview show THIS till's business name, never a
// reference business's. They render a shared sample ticket; that ticket used to carry one real business's name,
// till number and cashier, so every client's printer printed another business's details.
//
//   node test/test-print-business-name.test.mjs     (run `npx tsc -b tsconfig.main.json` first)
//
// Drives the REAL compiled dist/main/print/printWorker.js — its real `escpos:preview` handler, the one the
// Printers screen calls — against a REAL in-memory SQLite (the app's own better-sqlite3 driver). Only Electron's
// IPC is shimmed, so the handler can be called directly.
//
// MUTATIONS TO CONFIRM BITE:
//   - preview renders `sampleBusiness` again instead of sampleBusinessForThisTill() → "shows the till's own name" fails
//   - drop the `.trim() ||` fallback                                              → "a blank name falls back" fails
//   - put any real business's data back in sampleTicket.ts                        → the neutral-sample checks fail
//                                                                                   (and scripts/check-reference-names.mjs)
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

// ── shim: electron (IPC only) ────────────────────────────────────────────────
const handlers = {};
const shimDir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'swiftpos-a322-'));
fs.writeFileSync(path.join(shimDir, 'electron.js'),
  'module.exports = { ipcMain: { handle: (c, f) => { globalThis.__a322handlers[c] = f; } }, BrowserWindow: class {}, app: { getPath: () => ' + JSON.stringify(shimDir) + ' } };');
globalThis.__a322handlers = handlers;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return path.join(shimDir, 'electron.js');
  return origResolve.call(this, req, parent, ...rest);
};

const Database = require('better-sqlite3');
const { initPrinting } = require(path.join(dist, 'print', 'printWorker.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); pass++; } else { console.log(`  FAIL ${name}  ${detail}`); fail++; }
};

// One printWorker module instance holds one db; re-init with a fresh db per case (initPrinting re-registers
// the handlers, which the shim simply overwrites).
function previewWith(sessionName /* string | null | undefined (= no session row) */) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE session (id INTEGER PRIMARY KEY, business_name TEXT NOT NULL)');
  if (sessionName !== undefined) db.prepare('INSERT INTO session (id, business_name) VALUES (1, ?)').run(sessionName ?? '');
  initPrinting(db, () => null);
  return handlers['escpos:preview'](null, { stationId: 'receipt', paperWidthMm: 80 });
}

console.log('A322 — test print / preview business name\n');

const own = previewWith('Sample Grill House');
ok('the preview shows THIS till\'s business name', typeof own === 'string' && own.includes('Sample Grill House'), String(own).slice(0, 200));
ok('…and not the neutral fallback when a name exists', !own.includes('Your Business'));

const none = previewWith(undefined);
ok('no session row yet (not enrolled) → "Your Business"', none.includes('Your Business'), String(none).slice(0, 200));

const blank = previewWith('   ');
ok('a blank name falls back to "Your Business"', blank.includes('Your Business'));

// The rest of the sample is neutral — it prints on every client's paper.
ok('neutral branch on the sample', own.includes('Main Branch'));
ok('neutral till number (no real Buy Goods number)', /Buy Goods: 000000/.test(own), (own.match(/Buy Goods:[^\n|]*/) || [''])[0]);
ok('neutral cashier', /Cashier: Amina/.test(own));
ok('neutral phone', /0700 000 000/.test(own) && !/0700 000 033|0117 000 033/.test(own));

// The test print (escpos:test) renders through the same helper — it needs a printer, so pin the call site.
const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'print', 'printWorker.ts'), 'utf8');
ok('the test print uses the same helper as the preview',
  (src.match(/business: sampleBusinessForThisTill\(\)/g) || []).length === 2 && !/business: sampleBusiness[,\s}]/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
