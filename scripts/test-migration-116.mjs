/**
 * test-migration-116.mjs — A383: public.watchdog_alerts (what the cloud watchdog already told the admin) — PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: drop the partial unique index → "one OPEN alert per problem" fails; drop the severity CHECK
 * → "a severity we do not use is refused" fails; drop ON DELETE CASCADE → "deleting a client deletes its alerts" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/116_watchdog_alerts.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

console.log('\nMigration 116 (watchdog_alerts) — PGlite\n');
const db = new PGlite();
await db.exec(`
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  CREATE TABLE public.businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
  INSERT INTO public.businesses (name) VALUES ('African Fries');
`);
await db.exec(SQL);
const BIZ = (await db.query(`SELECT id FROM public.businesses LIMIT 1`)).rows[0].id;

await ok('an alert is stored with its defaults (seen now, not yet sent, open)', async () => {
  await db.exec(`INSERT INTO public.watchdog_alerts (alert_key, severity, business_id, title) VALUES ('till_not_syncing:d1', 'critical', '${BIZ}', 'T1 not syncing')`);
  const r = await db.query(`SELECT notify_count, resolved_at, first_seen_at IS NOT NULL AS seen FROM public.watchdog_alerts`);
  assert.deepStrictEqual(r.rows[0], { notify_count: 0, resolved_at: null, seen: true });
});
await ok('one OPEN alert per problem', async () => {
  const e = await threw(() => db.exec(`INSERT INTO public.watchdog_alerts (alert_key, severity, title) VALUES ('till_not_syncing:d1', 'critical', 'again')`));
  assert.ok(e && /watchdog_alerts_open_key|duplicate|unique/i.test(e.message), e?.message);
});
await ok('once resolved, the same problem may come back as a new alert', async () => {
  await db.exec(`UPDATE public.watchdog_alerts SET resolved_at = now() WHERE alert_key = 'till_not_syncing:d1'`);
  await db.exec(`INSERT INTO public.watchdog_alerts (alert_key, severity, title) VALUES ('till_not_syncing:d1', 'critical', 'back')`);
  const r = await db.query(`SELECT count(*)::int AS n FROM public.watchdog_alerts WHERE alert_key = 'till_not_syncing:d1'`);
  assert.strictEqual(r.rows[0].n, 2);
});
await ok('a severity we do not use is refused', async () => {
  const e = await threw(() => db.exec(`INSERT INTO public.watchdog_alerts (alert_key, severity, title) VALUES ('x', 'info', 'x')`));
  assert.ok(e && /watchdog_alerts_severity_check/.test(e.message), e?.message);
});
await ok('a cloud-wide alert has no client (business_id NULL)', async () => {
  await db.exec(`INSERT INTO public.watchdog_alerts (alert_key, severity, title) VALUES ('server_errors', 'critical', 'burst')`);
});
await ok('deleting a client deletes its alerts', async () => {
  await db.exec(`INSERT INTO public.watchdog_alerts (alert_key, severity, business_id, title) VALUES ('old_tills:b', 'warning', '${BIZ}', 'old')`);
  await db.exec(`DELETE FROM public.businesses WHERE id = '${BIZ}'`);
  const r = await db.query(`SELECT count(*)::int AS n FROM public.watchdog_alerts WHERE business_id IS NOT NULL`);
  assert.strictEqual(r.rows[0].n, 0);
});
await ok('row level security is on (only the cloud\'s service role reads it)', async () => {
  const r = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'watchdog_alerts'`);
  assert.strictEqual(r.rows[0].relrowsecurity, true);
});
await ok('re-running is harmless (idempotent) and recorded once', async () => {
  await db.exec(SQL);
  const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '116_watchdog_alerts'`);
  assert.strictEqual(r.rows[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
