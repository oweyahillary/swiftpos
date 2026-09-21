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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
