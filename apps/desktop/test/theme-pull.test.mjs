// A325 (Phase 2 slice 2) — the till stores the effective action theme the cloud serves, WITHOUT disturbing the
// logo or colour, and the value survives the other branding writers.
//
//   node test/theme-pull.test.mjs        (run `npx tsc -b tsconfig.main.json` first)
//
// Drives the REAL compiled dist/main/localDb.js on a REAL SQLite file — the real schema, the real schema-53 → 54
// upgrade (migrateColumns), the real writers — with only Electron's app.getPath pointed at a temp folder.
//
// MUTATIONS TO CONFIRM BITE:
//   - drop the migrateColumns(theme_id) line                 → "an existing schema-53 till gains theme_id" fails
//   - applyPulledTheme treats undefined like null            → "undefined (older cloud) keeps the stored theme" fails
//   - applyPulledBranding's upsert sets theme_id too         → "a later branding pull keeps the theme" fails
//   - accept any string as an id                             → "a malformed id is stored as null" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ── Shim electron: only app.getPath is used, pointed at a temp folder with an EXISTING schema-53 database ──
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-a325-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)} }, ipcMain: { handle() {} }, BrowserWindow: class {} };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

// A till as it is today on 0.6.4 (schema 53): branding table WITHOUT theme_id, with a real brand colour + logo.
{
  const old = new Database(path.join(userData, 'swiftpos.db'));
  old.exec(`CREATE TABLE branding (business_id TEXT PRIMARY KEY, accent_hex TEXT, logo_png TEXT, logo_receipt TEXT,
            synced_at TEXT, receipt_logo_enabled INTEGER NOT NULL DEFAULT 0);
            INSERT INTO branding (business_id, accent_hex, logo_png, receipt_logo_enabled) VALUES ('biz-1', '#F5B800', 'data:image/png;base64,AAAA', 1);`);
  old.close();
}

const L = require(path.join(dist, 'localDb.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const db = L.getLocalDb();
const cols = db.prepare(`PRAGMA table_info(branding)`).all().map((c) => c.name);

console.log('A325 — till stores the effective theme\n');
ok('an existing schema-53 till gains theme_id on upgrade', cols.includes('theme_id'), cols.join(','));
ok('the local schema version is 54', L.LOCAL_SCHEMA_VERSION === 54, String(L.LOCAL_SCHEMA_VERSION));
ok('the upgrade keeps the brand colour, logo and receipt toggle', (() => { const b = L.getBranding();
  return b && b.accentHex === '#F5B800' && b.logoPng === 'data:image/png;base64,AAAA' && b.receiptLogoEnabled === true && b.themeId === null; })(),
  JSON.stringify(L.getBranding()));

// No owner session yet (not enrolled) → nothing to key the row to → no-op.
L.applyPulledTheme('violet');
ok('before enrolment (no session) the theme is not written', L.getBranding().themeId === null);

db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-1', 'biz-1', 'Your Business', '2026-09-24T00:00:00Z')`).run();
L.applyPulledTheme('violet');
ok('the served theme is stored', L.getBranding().themeId === 'violet');
ok('…without touching the colour, logo or receipt toggle', (() => { const b = L.getBranding();
  return b.accentHex === '#F5B800' && b.logoPng === 'data:image/png;base64,AAAA' && b.receiptLogoEnabled === true; })());

L.applyPulledTheme(undefined);
ok('undefined (a cloud before A325) keeps the stored theme', L.getBranding().themeId === 'violet');
L.applyPulledTheme(null);
ok('null (themes switched off) clears it → the till goes back to today\'s look', L.getBranding().themeId === null);
L.applyPulledTheme('sky');
L.applyPulledTheme("sky'); DROP TABLE branding; --");
ok('a malformed id is stored as null, and nothing else happens', L.getBranding()?.themeId === null
  && db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name='branding'`).get().n === 1);

L.applyPulledTheme('lagoon');
L.applyPulledBranding({ accentHex: '#DC2626', logoPng: null, logoReceipt: null, receiptLogoEnabled: false });
ok('a later branding pull keeps the theme (it owns the colour/logo columns, not theme_id)', L.getBranding().themeId === 'lagoon',
  JSON.stringify(L.getBranding()));
ok('…and applies its own values (remote-wins)', L.getBranding().accentHex === '#DC2626' && L.getBranding().logoPng === null);

// A business with themes but NO branding row at all: the theme alone creates the row.
db.prepare(`UPDATE session SET business_id = 'biz-2' WHERE id = 1`).run();
L.applyPulledTheme('orchid');
const row2 = db.prepare(`SELECT accent_hex, logo_png, theme_id FROM branding WHERE business_id = 'biz-2'`).get();
ok('themes without a branding row: the theme alone is stored (colour and logo stay empty)',
  row2 && row2.theme_id === 'orchid' && row2.accent_hex === null && row2.logo_png === null, JSON.stringify(row2));

// The pull wiring (a genuine pull through syncEngine is covered by catalogue-refresh-signal; this pins the field).
const se = fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8');
ok('the pull reads top-level themeId, undefined when the cloud omits it',
  /themeId: 'themeId' in _j \? \(typeof _j\.themeId === 'string' \? _j\.themeId : null\) : undefined,/.test(se));
ok('…and stores it only when sent', /if \(c\.themeId !== undefined\) applyPulledTheme\(c\.themeId\);/.test(se));

L.closeLocalDb?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
