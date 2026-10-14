/**
 * tz-format.test.mjs — A478: the cloud's scheduled emails read Nairobi time on a UTC server.
 *
 * date-fns-tz's `format(date, fmt, { timeZone })` does NOT convert — it formats the machine's local time (the option
 * only feeds the zone tokens). On a Nairobi-time PC that looks right; on Render (UTC) the branch managers' 21:00 email,
 * the 09:00 repeat, the Monday 08:00 summary and the 1st-of-the-month pack all ran three hours late. CI (UTC) caught it
 * through tests/owner-alerts.test.mjs. Each job now uses formatInTimeZone, which converts.
 *
 *   TZ=UTC node tests/tz-format.test.mjs
 *
 * MUTATION TO CONFIRM BITE: import `format as tzFormat` again in ownerAlerts.ts → "no job formats with date-fns-tz's
 * format" fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}  ${d}`); } };

const { formatInTimeZone } = require('date-fns-tz');
const at = new Date('2026-10-14T18:05:00Z');   // 21:05 in Nairobi
ok('formatInTimeZone gives Nairobi\'s clock whatever the machine\'s zone', formatInTimeZone(at, 'Africa/Nairobi', 'yyyy-MM-dd HH:mm') === '2026-10-14 21:05',
  formatInTimeZone(at, 'Africa/Nairobi', 'yyyy-MM-dd HH:mm'));

// P1-7 (audit 2026-10-14): the old exemption ("zones first" = the FILE contains toZonedTime anywhere) passed
// dailySummary.ts, whose 21:00 send decision formatted the raw instant — the email went at 00:00 Nairobi and said "No sales
// recorded today". The rule is now absolute: no file of the server imports `format` from date-fns-tz (in any spelling,
// `format` or `format as x`, or through a namespace import); every caller uses formatInTimeZone, which converts.
const SRC = path.join(ROOT, 'apps/server/src');
const tsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
let seen = 0;
for (const file of tsFiles(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/from ['"]date-fns-tz['"]/.test(src)) continue;
  seen++;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const named = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]date-fns-tz['"]/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]));
  ok(`${rel}: does not import date-fns-tz's format (use formatInTimeZone)`, !named.includes('format'), named.join(', '));
  ok(`${rel}: no namespace / default import of date-fns-tz (format would hide behind it)`,
    !/import\s+\*\s+as\s+\w+\s+from\s+['"]date-fns-tz['"]/.test(src) && !/import\s+\w+\s*(,|from)\s*[^;]*['"]date-fns-tz['"]/.test(src));
}
ok('the scan found the server\'s date-fns-tz users (dailySummary, ownerAlerts, monthlyPack)', seen >= 3, String(seen));
const jobs = path.join(ROOT, 'apps/server/src/jobs');
const oa = fs.readFileSync(path.join(jobs, 'ownerAlerts.ts'), 'utf8');
const mp = fs.readFileSync(path.join(jobs, 'monthlyPack.ts'), 'utf8');
const ds = fs.readFileSync(path.join(jobs, 'dailySummary.ts'), 'utf8');
ok('the alert job and the monthly pack job convert with formatInTimeZone',
  /import \{ formatInTimeZone \} from 'date-fns-tz';/.test(oa) && /import \{ formatInTimeZone \} from 'date-fns-tz';/.test(mp));
ok('the daily email decides and labels its day with formatInTimeZone',
  /formatInTimeZone\(now, EAT, 'yyyy-MM-dd'\)/.test(ds) && /formatInTimeZone\(now, EAT, 'HH:mm'\)/.test(ds));

// The behaviour itself, on the BUILT job: at 21:05 Nairobi (18:05 UTC) a business whose report is due at 21:00 is sent
// today's email — on a UTC machine the old code read 18:05 and sent nothing (or, after midnight UTC, sent tomorrow's empty one).
{
  const DIST = path.join(ROOT, 'apps/server/dist');
  if (fs.existsSync(path.join(DIST, 'jobs/dailySummary.js'))) {
    const { randomBytes } = await import('node:crypto');
    process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
    process.env.JWT_SECRET ??= randomBytes(24).toString('hex');
    const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
    const mailer = require(path.join(DIST, 'lib/mailer.js'));
    const sent = []; mailer.sendEmail = async (m) => { sent.push(m); };
    const BZ = '11111111-1111-4111-8111-111111111111';
    const db = {
      businesses: [{ id: BZ, name: 'Nairobi Grill', owner_id: 'x', currency: 'KES' }],
      business_settings: [{ id: 's1', business_id: BZ, key: 'report_schedule', value: { enabled: true, send_time: '21:00', recipients: ['books@biz.test'] } }],
      orders: [{ id: 'o1', business_id: BZ, status: 'completed', total: 500, vat_amount: 69, cashier_id: null, created_at: '2026-10-14T10:00:00Z' }],
      order_price_variances: [], notifications: [], users: [], branches: [],
    };
    supabase.from = (t) => {
      const f = []; let ins = null; let rng = null;
      const q = new Proxy({}, { get(_x, p) {
        if (p === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
        if (p === 'gte') return (k, v) => { f.push((r) => String(r[k]) >= v); return q; };
        if (p === 'lt') return (k, v) => { f.push((r) => String(r[k]) < v); return q; };
        if (p === 'range') return (a, b) => { rng = [a, b]; return q; };
        if (p === 'insert') return (r) => { ins = r; (db[t] ??= []).push(r); return q; };
        const rows = () => { const all = (db[t] ?? []).filter((r) => f.every((fn) => fn(r))); return rng ? all.slice(rng[0], rng[1] + 1) : all; };
        if (p === 'maybeSingle') return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        if (p === 'then') return (res, rej) => Promise.resolve(ins ? { data: null, error: null } : { data: rows(), count: rows().length, error: null }).then(res, rej);
        return () => q;
      } });
      return q;
    };
    const DS = require(path.join(DIST, 'jobs/dailySummary.js'));
    await DS.runDailySummary(new Date('2026-10-14T17:55:00Z'));   // 20:55 Nairobi
    ok('at 20:55 Nairobi the 21:00 daily email has not gone yet', sent.length === 0, String(sent.length));
    await DS.runDailySummary(new Date('2026-10-14T18:05:00Z'));   // 21:05 Nairobi
    ok('at 21:05 Nairobi (18:05 UTC) the 21:00 daily email goes, for 14 October', sent.length === 1 && /14 Oct/.test(sent[0]?.subject ?? ''),
      JSON.stringify(sent.map((m) => m.subject)));
    ok('…and reports the day\'s sale (not "No sales recorded today")', /KES 500\.00/.test(sent[0]?.html ?? ''), '');
    await DS.runDailySummary(new Date('2026-10-14T18:20:00Z'));
    ok('…once a day', sent.length === 1, String(sent.length));
  } else {
    console.log('(dist/ not built — the run of the built job is skipped; build apps/server to include it)');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
