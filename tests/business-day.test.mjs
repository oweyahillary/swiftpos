/**
 * business-day.test.mjs — 0.6.34: the business day ends at the owner's cut-off ("Business day ends at", 00:00–06:00).
 *
 * Owner, 2026-10-03: a hotel bar trading past midnight was locked at 00:00 until a manager closed the day. The shared
 * rule run for real; source assertions on the cloud (Express + Supabase: the setting, the branch override, pos/init, the
 * reports, the daily email) and the web (React). The till is run for real in apps/desktop/test/business-day.test.mjs.
 *
 * MUTATIONS TO CONFIRM BITE: businessDateEAT ignoring the cut-off → "a 01:30 sale belongs to the night before" fails;
 * businessRangeEAT dropping the cut-off → "a report day runs cut-off to cut-off" fails; the settings route storing any
 * value → its pin fails; pos/init not sending it → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const B = await import(pathToFileURL(path.join(ROOT, 'shared/businessDay.ts')).href);

await ok('the setting: 00:00–06:00 as "HH:MM"; empty = midnight; anything else refused', () => {
  assert.strictEqual(B.cleanCutoff('04:00'), 240);
  assert.strictEqual(B.cleanCutoff('6:00'), 360);
  assert.strictEqual(B.cleanCutoff(''), 0);
  assert.strictEqual(B.cleanCutoff(null), 0);
  for (const bad of ['06:01', '07:00', '24:00', '4pm', '-1', 361]) assert.strictEqual(B.cleanCutoff(bad), undefined, String(bad));
  assert.strictEqual(B.cutoffSettingValue('4:30'), '04:30');
  assert.strictEqual(B.cutoffSettingValue('9:00'), null);
});
await ok('a 01:30 sale belongs to the night before (04:00 cut-off); at midnight, to the new day', () => {
  const t = new Date('2026-10-03T01:30:00+03:00');
  assert.strictEqual(B.businessDateEAT(t, 240), '2026-10-02');
  assert.strictEqual(B.businessDateEAT(t, 0), '2026-10-03');
  assert.strictEqual(B.businessDateEAT(new Date('2026-10-03T04:00:00+03:00'), 240), '2026-10-03');
});
await ok('a report day runs cut-off to cut-off (East Africa Time); the default is exactly midnight-to-midnight', () => {
  assert.deepStrictEqual(B.businessRangeEAT('2026-10-02', '2026-10-02', 240),
    { start: '2026-10-02T01:00:00.000Z', end: '2026-10-03T00:59:59.999Z' });
  assert.deepStrictEqual(B.businessRangeEAT('2026-10-02', '2026-10-02', 0),
    { start: '2026-10-01T21:00:00.000Z', end: '2026-10-02T20:59:59.999Z' });
});

// ── The cloud (source) ────────────────────────────────────────────────────────
await ok('the setting is stored only as a valid "HH:MM"; a branch may override it with a valid one', () => {
  const b = read('apps/server/src/routes/business.ts');
  assert.match(b, /if \(key === BUSINESS_DAY_CUTOFF_KEY\) \{\s*const clean = cutoffSettingValue\(value\);\s*if \(clean === null\) \{/);
  assert.match(b, /'continuous_operation',\s*\/\/[^\n]*\n\s*'business_day_cutoff',/);
  const br = read('apps/server/src/routes/branches.ts');
  assert.match(br, /const OVERRIDABLE_KEYS = \['receipt_header', 'receipt_footer', 'continuous_operation', 'business_day_cutoff'\];/);
  assert.match(br, /if \(key === 'business_day_cutoff'\) \{\s*const clean = cutoffSettingValue\(value\);/);
});
await ok('the till hears it with pos/init (the branch\'s own wins)', () => {
  const p = read('apps/server/src/routes/pos.ts');
  assert.match(p, /'continuous_operation', 'business_day_cutoff', 'order_note_picks',/);
  assert.match(p, /\.in\('key', \['receipt_header', 'receipt_footer', 'continuous_operation', 'business_day_cutoff'\]\)/);
  assert.match(p, /businessDayCutoff: cleanCutoff\(receiptText\.business_day_cutoff\) \?\? 0,/);
});
await ok('the reports and the daily email count the business day', () => {
  const r = read('apps/server/src/routes/reports.ts');
  assert.match(r, /function getDateRange\(from\?: string, to\?: string, cutoffMinutes = 0\) \{\s*const today = businessDateEAT\(new Date\(\), cutoffMinutes\);\s*return businessRangeEAT\(from \|\| today, to \|\| today, cutoffMinutes\);/);
  assert.match(r, /\(req as any\)\.dayCutoff = await getDayCutoff\(req\.businessId, branch\);/);
  assert.ok(!/getDateRange\(from as string, to as string\)/.test(r), 'a report still ignores the cut-off');
  const d = read('apps/server/src/jobs/dailySummary.ts');
  assert.match(d, /const cutoff = await getDayCutoff\(biz\.id\);/);
  assert.match(d, /await sendSummaryForBusiness\(biz, range\.start, range\.end, recipients\);/);
});
await ok('the web: the owner sets it (half-hour steps to 06:00), per branch too; the web POS History follows it', () => {
  assert.match(read('apps/dashboard/src/pages/settings/BusinessProfileTab.tsx'), /onChange=\{e => saveSetting\('business_day_cutoff', e\.target\.value\)\}/);
  assert.match(read('apps/dashboard/src/pages/settings/BranchReceiptOverrides.tsx'), /data-testid="branch-day-cutoff"/);
  assert.match(read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx'), /const \[by, bm, bd\] = businessDateLocal\(new Date\(\), cut\)\.split\('-'\)\.map\(Number\);/);
  assert.match(read('apps/dashboard/src/pages/pos/cashier/usePOSData.ts'), /setWebDayCutoff\(\(init as any\)\.businessDayCutoff\);/);
});
await ok('the till must be on schema 64 (the cut-off column)', () => {
  assert.ok(Number(/export const REQUIRED_DESKTOP_SCHEMA = (\d+);/.exec(read('apps/server/src/lib/desktopSchema.ts'))[1]) >= 64);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
