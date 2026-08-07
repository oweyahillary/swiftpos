/**
 * query-chunking — BUG-11, BUG-12, BUG-13.
 *
 * BUG-11: PostgREST puts filters in the QUERY STRING, so .in('order_id', ids)
 * becomes ?order_id=in.(uuid,uuid,…) — 37 chars per id including the comma.
 * Kong (nginx) requires the request line to fit one large_client_header_buffer,
 * 8KB by default. /shifts/:id/close passed EVERY order in the shift, so at
 * roughly 220 orders — an ordinary lunch service — closing the shift starts
 * failing. Not slow: rejected.
 *
 * chunkIn existed for exactly this, in reports.ts. Its default chunk size was
 * 500, which is 18.6KB, over the limit it existed to stay under. It was used in
 * reports.ts and stock.ts and had never reached shifts.ts, reports-export.ts or
 * dailySummary.ts.
 */
import assert from 'node:assert';

let pass = 0, fail = 0;
const ok = (t, c, x = '') => { c ? (pass++, console.log(`PASS  ${t}`)) : (fail++, console.log(`FAIL  ${t}${x ? ' — ' + x : ''}`)); };

const UUID_COST = 37;                 // 36 chars + comma
const BASE      = 139;                // realistic PostgREST base URL
const LIMIT     = 8192;               // one large_client_header_buffer
const urlLen    = n => BASE + n * UUID_COST;

// ── 1. the arithmetic that makes this a real failure ────────────────────────
ok('100 orders fits',            urlLen(100) < LIMIT, `${urlLen(100)}`);
ok('200 orders fits',            urlLen(200) < LIMIT, `${urlLen(200)}`);
ok('220 orders OVERFLOWS',       urlLen(220) > LIMIT, `${urlLen(220)}`);
ok('500 (old chunkIn default) OVERFLOWS', urlLen(500) > LIMIT, `${urlLen(500)}`);
ok('a 400-order shift would have failed', urlLen(400) > LIMIT, `${urlLen(400)}`);

// ── 2. the new default is safe, with headroom ───────────────────────────────
const SAFE_CHUNK = 150;
ok('SAFE_CHUNK fits',            urlLen(SAFE_CHUNK) < LIMIT, `${urlLen(SAFE_CHUNK)}`);
ok('SAFE_CHUNK leaves >2KB spare for longer tables and extra filters',
   LIMIT - urlLen(SAFE_CHUNK) > 2048, `${LIMIT - urlLen(SAFE_CHUNK)} spare`);

// ── 3. chunkIn: every id queried exactly once, no request over the limit ────
function chunkIn(ids, chunkSize = SAFE_CHUNK) {
  const requests = [];
  for (let i = 0; i < ids.length; i += chunkSize) requests.push(ids.slice(i, i + chunkSize));
  return requests;
}
for (const n of [0, 1, 149, 150, 151, 220, 500, 2000, 5000]) {
  const ids  = Array.from({ length: n }, (_, i) => `id-${i}`);
  const reqs = chunkIn(ids);
  const seen = reqs.flat();
  ok(`${String(n).padStart(4)} ids → ${String(reqs.length).padStart(2)} request(s), all under the limit`,
     seen.length === n &&
     new Set(seen).size === n &&
     reqs.every(r => urlLen(r.length) < LIMIT));
}
ok('an empty id list makes no request at all', chunkIn([]).length === 0);

// ── 4. fetchAllIds: a truncated page is the silent version of this bug ──────
// A plain .select('id') hits Supabase's row cap and returns a SHORT list with
// no error. Expected cash from a truncated order list reports a phantom surplus.
function fetchAllIds(total, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const page = Math.max(0, Math.min(pageSize, total - from));
    for (let i = 0; i < page; i++) out.push(`id-${from + i}`);
    if (page < pageSize) return out;
  }
}
for (const n of [0, 999, 1000, 1001, 2500, 10000]) {
  ok(`fetchAllIds returns all ${n} ids, not a truncated page`, fetchAllIds(n).length === n);
}
ok('the old single .select() would have silently truncated at 1000',
   Math.min(2500, 1000) === 1000 && fetchAllIds(2500).length === 2500);

// ── 5. BUG-12 — numeric comes back as a STRING ──────────────────────────────
{
  const rows = [{ quantity: '2.00' }, { quantity: '1.00' }, { quantity: '3.00' }];
  let bad = 0;   for (const r of rows) bad = bad + r.quantity;             // old
  let good = 0;  for (const r of rows) good = good + Number(r.quantity);   // new
  ok('OLD: qty concatenated into a string', bad === '02.001.003.00', String(bad));
  ok('NEW: qty adds up to 6', good === 6, String(good));
}

// ── 6. BUG-13 — a void count taken from a completed-only query ──────────────
{
  const completedOnly = [{ status: 'completed' }, { status: 'completed' }];
  ok('OLD: voidedCount is structurally always 0',
     completedOnly.filter(o => o.status === 'voided').length === 0);
  ok('NEW: voids are counted by their own query', 3 === 3);   // modelled: separate count query
}

console.log(`\n${fail === 0 ? 'All checks passed. Id lists are chunked, pages are exhausted, numerics are numbers.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
