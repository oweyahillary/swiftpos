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

const jobs = path.join(ROOT, 'apps/server/src/jobs');
for (const f of fs.readdirSync(jobs).filter((x) => x.endsWith('.ts'))) {
  const src = fs.readFileSync(path.join(jobs, f), 'utf8');
  if (!src.includes("from 'date-fns-tz'")) continue;
  // dailySummary zones the instant first (toZonedTime) and formats the zoned copy — that is correct and allowed.
  const zonesFirst = /toZonedTime\(/.test(src);
  const plainFormat = /import \{[^}]*\bformat\b[^}]*\} from 'date-fns-tz'/.test(src);
  ok(`${f}: no job formats with date-fns-tz's format unless it zones the instant first`, !plainFormat || zonesFirst);
}
const oa = fs.readFileSync(path.join(jobs, 'ownerAlerts.ts'), 'utf8');
const mp = fs.readFileSync(path.join(jobs, 'monthlyPack.ts'), 'utf8');
ok('the alert job and the monthly pack job convert with formatInTimeZone',
  /import \{ formatInTimeZone \} from 'date-fns-tz';/.test(oa) && /import \{ formatInTimeZone \} from 'date-fns-tz';/.test(mp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
