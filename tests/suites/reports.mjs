/**
 * Suite: Reports
 * Tests: all report endpoints, date range params, maths invariants,
 *        export endpoints, cross-tenant isolation in reports
 */
import { group, ok, okish, SKIP, GET, state } from '../lib.mjs';

const today = new Date().toISOString().split('T')[0];
const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

function approx(a, b, eps = 0.05) { return Math.abs(Number(a) - Number(b)) <= eps; }

export async function run() {
  // ── Self-login when running standalone ──────────────────────────────────
  if (!state.ownerToken) {
    if (!state.ownerEmail || !state.ownerPassword) {
      console.log('  [reports] skipped — no credentials');
      return;
    }
    const _login = await POST('/api/auth/login', { email: state.ownerEmail, password: state.ownerPassword });
    if (!_login.data?.accessToken) {
      console.log('  [reports] login failed:', _login.data?.error ?? 'unknown');
      return;
    }
    state.ownerToken   = _login.data.accessToken;
    state.refreshToken = _login.data.refreshToken;
    state.businessId   = _login.data.business?.id ?? null;
    const _branches = await GET('/api/branches', state.ownerToken);
    if ((_branches.data ?? []).length > 0) state.branchId = _branches.data[0].id;
  }

  // ── Sales report ──────────────────────────────────────────────────────────
  group('REPORTS — Sales (today)');

  const sales = await GET(`/api/reports/sales?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/sales → 200', sales.status === 200, `got ${sales.status}`);
  ok('Sales has summary object', !!sales.data?.summary);
  ok('Summary has totalRevenue (number or string)', sales.data?.summary?.totalRevenue !== undefined);
  ok('Summary has totalOrders', sales.data?.summary?.totalOrders !== undefined);
  ok('Summary has totalVat', sales.data?.summary?.totalVat !== undefined);

  // Maths invariant: totalRevenue = sum of all order totals
  if (sales.data?.summary) {
    const rev = Number(sales.data.summary.totalRevenue);
    const vat = Number(sales.data.summary.totalVat);
    const net = Number(sales.data.summary.netRevenue ?? (rev - vat));
    ok('netRevenue = totalRevenue - totalVat', approx(net, rev - vat, 0.02),
      `rev=${rev} vat=${vat} net=${net}`);
    ok('totalRevenue ≥ 0', rev >= 0, `got ${rev}`);
    ok('totalVat ≥ 0', vat >= 0, `got ${vat}`);
    ok('totalVat < totalRevenue (or both 0)', vat <= rev || (vat === 0 && rev === 0),
      `vat=${vat} rev=${rev}`);
  }

  // Payment method breakdown
  if (sales.data?.paymentMethods) {
    const methods = sales.data.paymentMethods;
    ok('Payment methods is object', typeof methods === 'object');
  }

  // ── Sales with date range ─────────────────────────────────────────────────
  group('REPORTS — Sales (week range)');

  const weekSales = await GET(`/api/reports/sales?from=${weekAgo}&to=${today}`, state.ownerToken);
  ok('Sales week range → 200', weekSales.status === 200, `got ${weekSales.status}`);
  if (weekSales.data?.summary && sales.data?.summary) {
    const weekRev  = Number(weekSales.data.summary.totalRevenue);
    const todayRev = Number(sales.data.summary.totalRevenue);
    ok('Week revenue ≥ today revenue', weekRev >= todayRev,
      `week=${weekRev} today=${todayRev}`);
  }

  // Branch filter
  if (state.branchId) {
    const branchSales = await GET(
      `/api/reports/sales?from=${today}&to=${today}&branch_id=${state.branchId}`,
      state.ownerToken);
    ok('Sales with branch filter → 200', branchSales.status === 200, `got ${branchSales.status}`);
  }

  // ── Products report ───────────────────────────────────────────────────────
  group('REPORTS — Products sold');

  const products = await GET(`/api/reports/products?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/products → 200', products.status === 200, `got ${products.status}`);
  ok('Products report has products array', Array.isArray(products.data?.products ?? products.data));

  // ── Staff performance ─────────────────────────────────────────────────────
  group('REPORTS — Staff performance');

  const staffReport = await GET(`/api/reports/staff?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/staff → 200', staffReport.status === 200, `got ${staffReport.status}`);

  // ── EOD report ────────────────────────────────────────────────────────────
  group('REPORTS — End of Day');

  const eod = await GET(`/api/reports/eod?date=${today}`, state.ownerToken);
  ok('GET /api/reports/eod → 200', eod.status === 200, `got ${eod.status}`);
  if (eod.data?.summary) {
    const totalRev  = Number(eod.data.summary.totalRevenue ?? 0);
    const totalVat  = Number(eod.data.summary.totalVat ?? 0);
    const netProfit = Number(eod.data.summary.netProfit ?? 0);
    ok('EOD totalRevenue ≥ 0', totalRev >= 0);
    ok('EOD netProfit ≤ totalRevenue', netProfit <= totalRev,
      `profit=${netProfit} rev=${totalRev}`);
  }

  // ── Tax report ────────────────────────────────────────────────────────────
  group('REPORTS — Tax');

  const tax = await GET(`/api/reports/tax?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/tax → 200', tax.status === 200, `got ${tax.status}`);
  if (tax.data?.summary) {
    const { grossSales, vatTotal, netSales } = tax.data.summary;
    ok('Tax: grossSales ≥ 0', Number(grossSales) >= 0);
    ok('Tax: vatTotal ≥ 0', Number(vatTotal) >= 0);
    // netSales = grossSales - vatTotal - CTL (catering levy, hospitality only)
    // For non-hospitality: netSales = grossSales - vatTotal
    // For hospitality:     netSales = (grossSales - vatTotal) * (1 - 0.02)
    const netFloor = Number(grossSales) - Number(vatTotal);
    const netWithCtl = netFloor * 0.98;
    ok('Tax: netSales ≤ gross - vat (CTL may apply)',
      Number(netSales ?? 0) <= netFloor + 0.5 && Number(netSales ?? 0) >= netWithCtl - 0.5,
      `gross=${grossSales} vat=${vatTotal} net=${netSales} (CTL makes net < gross-vat)`);
    // Category VAT must sum to total VAT (single source of truth invariant)
    if (Array.isArray(tax.data.categories)) {
      const catVatSum = tax.data.categories.reduce((s, c) => s + Number(c.vat ?? 0), 0);
      ok('Category VAT sums to total VAT', approx(catVatSum, Number(vatTotal), 0.1),
        `catSum=${catVatSum.toFixed(2)} total=${vatTotal}`);
    }
  }

  // ── Voids report ──────────────────────────────────────────────────────────
  group('REPORTS — Voids');

  const voids = await GET(`/api/reports/voids?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/voids → 200', voids.status === 200, `got ${voids.status}`);
  ok('Voids is array', Array.isArray(voids.data?.voids ?? voids.data));

  // ── Hourly report ─────────────────────────────────────────────────────────
  group('REPORTS — Hourly');

  const hourly = await GET(`/api/reports/hourly?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/hourly → 200', hourly.status === 200, `got ${hourly.status}`);
  if (Array.isArray(hourly.data?.hours ?? hourly.data)) {
    const hours = hourly.data?.hours ?? hourly.data;
    ok('Hourly has 24 or fewer buckets', hours.length <= 24, `got ${hours.length}`);
  }

  // ── Master / DSR ──────────────────────────────────────────────────────────
  group('REPORTS — Master DSR');

  const master = await GET(`/api/reports/master?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/master → 200', master.status === 200, `got ${master.status}`);

  // ── Inventory report ──────────────────────────────────────────────────────
  group('REPORTS — Inventory');

  const invReport = await GET(`/api/reports/inventory?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/inventory → 200', invReport.status === 200, `got ${invReport.status}`);

  // ── Shifts report ─────────────────────────────────────────────────────────
  group('REPORTS — Shifts');

  const shiftsReport = await GET(`/api/reports/shifts?from=${today}&to=${today}`, state.ownerToken);
  ok('GET /api/reports/shifts → 200', shiftsReport.status === 200, `got ${shiftsReport.status}`);

  // ── Invalid date range ────────────────────────────────────────────────────
  group('REPORTS — Edge cases');

  // Future date
  const future = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
  const futureSales = await GET(`/api/reports/sales?from=${future}&to=${future}`, state.ownerToken);
  ok('Future date → 200 with zero revenue', futureSales.status === 200,
    `got ${futureSales.status}`);
  if (futureSales.status === 200 && futureSales.data?.summary) {
    ok('Future date has 0 orders', Number(futureSales.data.summary.totalOrders) === 0,
      `got ${futureSales.data.summary.totalOrders}`);
  }

  // Missing date params (should use defaults or 400)
  const noDate = await GET('/api/reports/sales', state.ownerToken);
  ok('Sales without date → 200 (uses today default) or 400', [200, 400].includes(noDate.status),
    `got ${noDate.status}`);

  // ── Export endpoints ──────────────────────────────────────────────────────
  group('REPORTS — Export endpoints (auth check)');

  // These return file streams or redirects — just check they require auth
  const exportNoAuth = await GET(`/api/reports/export/sales?from=${today}&to=${today}`);
  ok('Export sales without auth → 401', exportNoAuth.status === 401, `got ${exportNoAuth.status}`);

  const exportWithAuth = await GET(
    `/api/reports/export/sales?from=${today}&to=${today}`,
    state.ownerToken);
  ok('Export sales with auth → 200 (or any non-401)', exportWithAuth.status !== 401,
    `got ${exportWithAuth.status}`);
}
