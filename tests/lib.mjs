/**
 * lib.mjs — shared test helpers and state.
 * Imported by both runner.mjs and all suite files.
 * Kept separate to avoid circular dependency between runner ↔ suites.
 */

export const BASE_URL = { value: 'http://localhost:4000' };

export const state = {
  ownerToken:     null,
  ownerEmail:     null,
  ownerPassword:  null,
  refreshToken:   null,
  businessId:     null,
  branchId:       null,
  shiftId:        null,
  productId:      null,
  categoryId:     null,
  orderId:        null,
  orderNumber:    null,
  cashierId:      null,
  cashierToken:   null,
  customerId:     null,
  expenseCatId:   null,
  discountId:     null,
  staffId:        null,
};

// ── Test counters ─────────────────────────────────────────────────────────────
export const counts = { pass: 0, fail: 0, skip: 0, warn: 0 };
export const failures = [];
export let verbose = false;
export function setVerbose(v) { verbose = v; }

export function group(name) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('━'.repeat(60));
}

export function ok(name, cond, detail = '') {
  if (cond) {
    counts.pass++;
    if (verbose) console.log(`  ✓  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    counts.fail++;
    const msg = `  ✗  ${name}${detail ? '  →  ' + detail : ''}`;
    console.log(msg);
    failures.push({ name, detail });
  }
}

export function okish(name, cond, detail = '') {
  if (cond) { counts.pass++; if (verbose) console.log(`  ✓  ${name}`); }
  else { counts.warn++; console.log(`  ⚠  ${name}${detail ? '  →  ' + detail : ''}`); }
}

export function SKIP(name) {
  counts.skip++;
  if (verbose) console.log(`  -  ${name} [skipped]`);
}

export async function request(method, path, body, token, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL.value}${path}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data, ok: res.ok };
}

export const GET    = (p, t, h)    => request('GET',    p, null, t, h);
export const POST   = (p, b, t, h) => request('POST',   p, b,    t, h);
export const PATCH  = (p, b, t, h) => request('PATCH',  p, b,    t, h);
export const DELETE = (p, t, h)    => request('DELETE', p, null, t, h);

// Keep BASE as a convenience getter so suite files can do: import { BASE } from '../lib.mjs'
export function getBase() { return BASE_URL.value; }
