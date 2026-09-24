/**
 * branding-sync-pull.test.mjs — A304: the cloud→till branding sync-down is wired, and the
 * local write is remote-wins keyed by the session business.
 *
 *   node tests/branding-sync-pull.test.mjs
 *
 * The end-to-end pull needs a real server + migration 104 live (target/CI, rule 16). This
 * guards the source wiring on both ends, plus the remote-wins upsert semantics against a real
 * SQLite (node:sqlite stand-in — not the app's better-sqlite3 driver, A13).
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - drop `if (c.branding) applyPulledBranding` in syncEngine  -> "applyReferenceConfig applies branding" fails
 *   - stop selecting business_branding in pos /init             -> "server /init selects business_branding" fails
 *   - remove business_branding from the catalogue-version list  -> "server catalogue-version includes branding" fails
 *   - make applyPulled ignore the session business_id           -> "remote-wins keyed by session business" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

// ── source wiring ────────────────────────────────────────────────────────────
const sync = r('apps/desktop/src/main/syncEngine.ts');
const ldb  = r('apps/desktop/src/main/localDb.ts');
const refb = r('apps/desktop/src/main/referenceBundle.ts');
const pos  = r('apps/server/src/routes/pos.ts');

ok('syncEngine imports applyPulledBranding', /import\s*\{[^}]*applyPulledBranding[^}]*\}\s*from\s*['"]\.\/localDb['"]/.test(sync));
ok('applyReferenceConfig applies branding (guarded)', /if\s*\(\s*c\.branding\s*\)\s*applyPulledBranding\(\s*c\.branding\s*\)/.test(sync));
ok('cloud path sets branding from the init response', /branding:\s*\(\s*_j\.branding/.test(sync));
ok('referenceBundle config carries optional branding', /branding\?:\s*\{[^}]*accentHex[^}]*logoPng/.test(refb));
ok('applyPulledBranding is keyed by the session business', /applyPulledBranding/.test(ldb) && /FROM session WHERE id\s*=\s*1/.test(ldb) && /ON CONFLICT\(business_id\)/.test(ldb));
ok('server /init selects business_branding', /\.from\('business_branding'\)/.test(pos));
ok('server /init returns branding in the response', /branding:\s*branding\s*\?/.test(pos));
ok('server catalogue-version includes branding', /latest\('business_branding'/.test(pos));

// ── remote-wins upsert semantics (node:sqlite stand-in; SQL mirrors applyPulledBranding) ──
let db = null;
try { const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(':memory:'); }
catch { console.log('\n(skip DB section — node:sqlite unavailable; source guards above still ran)'); }
if (db) {
  db.exec(`CREATE TABLE session (id INTEGER PRIMARY KEY CHECK (id=1), business_id TEXT NOT NULL, business_name TEXT NOT NULL);`);
  db.exec(`CREATE TABLE branding (business_id TEXT PRIMARY KEY, accent_hex TEXT, logo_png TEXT, logo_receipt TEXT, synced_at TEXT);`);

  // Mirror of applyPulledBranding: key by the session business, upsert both columns (remote-wins).
  const applyPulled = (b) => {
    const sess = db.prepare(`SELECT business_id FROM session WHERE id = 1`).get();
    if (!sess?.business_id) return;
    db.prepare(`INSERT INTO branding (business_id, accent_hex, logo_png, synced_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(business_id) DO UPDATE SET
                  accent_hex=excluded.accent_hex, logo_png=excluded.logo_png, synced_at=excluded.synced_at`)
      .run(sess.business_id, b.accentHex, b.logoPng, new Date().toISOString());
  };
  const read = () => db.prepare(`SELECT business_id, accent_hex, logo_png FROM branding LIMIT 1`).get();

  ok('no session → no-op (nothing written)', (() => { applyPulled({ accentHex: '#0d9488', logoPng: 'x' }); return !read(); })());

  db.exec(`INSERT INTO session (id, business_id, business_name) VALUES (1, 'B1', 'Acme');`);
  applyPulled({ accentHex: '#0d9488', logoPng: 'data:image/png;base64,AAAA' });
  ok('remote-wins keyed by session business', (() => { const r = read(); return r.business_id === 'B1' && r.accent_hex === '#0d9488'; })());

  applyPulled({ accentHex: '#e11d48', logoPng: null });   // cloud row with a cleared logo
  ok('remote-wins overwrites (accent changed, logo cleared)', (() => { const r = read(); return r.accent_hex === '#e11d48' && r.logo_png === null; })());

  ok('still one row for the business', db.prepare(`SELECT count(*) c FROM branding`).get().c === 1);
}


// ── A311: the REAL applyPulledBranding SQL, executed (not mirrored) ──────────────────────────
// The upsert gained positional CASE WHEN ? binds; a bind-count slip type-checks and throws at
// runtime ("Too few parameter values") — the A167 class. So: extract the statement and the CREATE
// TABLE from localDb.ts's source text, run them on a real SQLite, and check the semantics.
// A325 appended theme_id to this select; the A311 intent is that the receipt fields are still selected.
ok('A311: server /init selects the receipt fields', /select\('accent_hex, logo_png, logo_receipt, receipt_logo_enabled(, [a-z_]+)*'\)/.test(pos));
ok('A311: server /init returns receiptLogoEnabled as a strict boolean', /receiptLogoEnabled:\s*branding\.receipt_logo_enabled\s*===\s*true/.test(pos));
ok('A311: syncEngine distinguishes absent (keep local) from null (clear)', /'logoReceipt'\s+in\s+_j\.branding/.test(sync) && /'receiptLogoEnabled'\s+in\s+_j\.branding/.test(sync));
// A325 moved the schema to 54; the A311 intent is that the till is at least on 53 (the column exists).
ok('A311: LOCAL_SCHEMA_VERSION is at least 53', Number((/LOCAL_SCHEMA_VERSION = (\d+)/.exec(ldb) || [])[1]) >= 53);
ok('A311: branding.receipt_logo_enabled migrated for existing tills', /migrateColumns\(db,\s*'branding',\s*\[\['receipt_logo_enabled'/.test(ldb));

if (db) {
  const fnSrc = ldb.slice(ldb.indexOf('export function applyPulledBranding'));
  const sqlM = /`(\s*INSERT INTO branding[\s\S]*?)`\s*,?\s*\)\.run\(([\s\S]*?)\);/.exec(fnSrc);
  const createM = /CREATE TABLE IF NOT EXISTS branding \(([\s\S]*?)\);/.exec(ldb);
  ok('A311: found the real upsert + CREATE TABLE in source', !!sqlM && !!createM);
  if (sqlM && createM) {
    const SQL = sqlM[1];
    const argCount = sqlM[2].split(',').length;
    const qCount = (SQL.match(/\?/g) || []).length;
    ok(`A311: bind count matches placeholder count (${argCount} args, ${qCount} ?)`, argCount === qCount);

    const d2 = new (await import('node:sqlite')).DatabaseSync(':memory:');
    d2.exec(`CREATE TABLE session (id INTEGER PRIMARY KEY CHECK (id=1), business_id TEXT NOT NULL);`);
    d2.exec(`CREATE TABLE IF NOT EXISTS branding (${createM[1]});`);
    d2.exec(`INSERT INTO session (id, business_id) VALUES (1, 'B1');`);
    const stmt = d2.prepare(SQL);
    // The bind DERIVATION is the source's own JS, not a copy — extracted from the `const lr =`
    // block and executed. A test that recomputed lrKeep/enKeep itself passed with those lines
    // mutated (found by mutation-check; rule 24), because it never ran them.
    const derivM = /(const lr = [\s\S]*?const enKeep = [^\n]*;)/.exec(fnSrc);
    ok('A311: found the bind-derivation block in source', !!derivM);
    const derive = new Function('b', `${derivM ? derivM[1] : ''}; return { lr, lrKeep, en, enKeep };`);
    const run = (b) => {
      const { lr, lrKeep, en, enKeep } = derive(b);
      // Same bind order as the source: (business_id, accentHex, logoPng, lr, en, now, lrKeep, enKeep, en)
      stmt.run('B1', b.accentHex, b.logoPng, lr, en, 'now', lrKeep, enKeep, en);
    };
    const read = () => d2.prepare(`SELECT accent_hex, logo_png, logo_receipt, receipt_logo_enabled FROM branding WHERE business_id='B1'`).get();

    ok('A311: the real statement executes (no bind error)', (() => { try { run({ accentHex: '#0d9488', logoPng: 'p', logoReceipt: 'mono1:8:1:AA==', receiptLogoEnabled: true }); return true; } catch (e) { console.log('      ' + e.message); return false; } })());
    ok('A311: first pull writes raster + toggle ON', (() => { const r = read(); return r.logo_receipt === 'mono1:8:1:AA==' && r.receipt_logo_enabled === 1; })());
    run({ accentHex: '#0d9488', logoPng: 'p' });                                  // old cloud: fields absent
    ok('A311: a cloud WITHOUT the fields keeps the local raster and toggle', (() => { const r = read(); return r.logo_receipt === 'mono1:8:1:AA==' && r.receipt_logo_enabled === 1; })());
    run({ accentHex: '#0d9488', logoPng: 'p', logoReceipt: 'mono1:8:1:AA==', receiptLogoEnabled: false });
    ok('A311: cloud toggle OFF wins (remote-wins)', read().receipt_logo_enabled === 0);
    run({ accentHex: '#0d9488', logoPng: 'p', logoReceipt: null, receiptLogoEnabled: true });
    ok('A311: cloud null raster CLEARS it while the toggle can be on (prints nothing, never throws)', (() => { const r = read(); return r.logo_receipt === null && r.receipt_logo_enabled === 1; })());
    ok('A311: still one row', d2.prepare(`SELECT count(*) c FROM branding`).get().c === 1);
    d2.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
