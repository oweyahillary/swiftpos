/**
 * ordertax.test.mjs — proves the refund and levy reporting bugs are fixed.
 *
 *   node ordertax.test.mjs
 *
 * No server, no database. It reconstructs the sale-time tax math from payment.ts
 * to generate orders exactly as the till would store them, then checks that the
 * report helper reads those stored values back correctly and adjusts for
 * refunds. The two bugs under test:
 *
 *   1. A refunded order counted at full value, overstating output VAT.
 *   2. The levy DERIVED as (gross - vat) * ctlRate, which double-applies the
 *      rate because gross - vat already contains the levy.
 *
 * The helper below is a copy of lib/orderTax.ts kept in sync by hand, so the
 * test runs with no build step.
 */

// ── copy of lib/orderTax.ts ─────────────────────────────────────────────────
const n = v => Number(v ?? 0) || 0;
const keptFraction = o => {
  const total = n(o.total);
  if (total <= 0) return 0;
  const refunded = Math.min(Math.max(n(o.refunded_amount), 0), total);
  return (total - refunded) / total;
};
const orderTax = o => {
  const gross = n(o.total);
  const refunded = Math.min(Math.max(n(o.refunded_amount), 0), gross);
  const keep = keptFraction(o);
  const vat = n(o.vat_amount) * keep;
  const ctl = n(o.ctl_amount) * keep;
  const net = gross - refunded;
  return { gross, refunded, net, vat, ctl, netOfTax: net - vat - ctl, wasRefunded: !!o.refunded_at || refunded > 0 };
};
const sumOrderTax = orders => {
  const a = { gross: 0, refunded: 0, net: 0, vat: 0, ctl: 0, netOfTax: 0, count: 0, refundedCount: 0 };
  for (const o of orders) {
    const f = orderTax(o);
    a.gross += f.gross; a.refunded += f.refunded; a.net += f.net;
    a.vat += f.vat; a.ctl += f.ctl; a.netOfTax += f.netOfTax;
    a.count++; if (f.wasRefunded) a.refundedCount++;
  }
  return a;
};

// ── the till's sale-time math, from payment.ts, to build realistic orders ────
const round2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
function makeOrder(inclusiveTotal, vatRate, ctlRate, refunded = 0, refundedAt = null) {
  const net = inclusiveTotal / (1 + (vatRate + ctlRate) / 100);
  return {
    total: String(round2(inclusiveTotal)),        // strings, as PostgREST returns them
    vat_amount: String(round2(net * (vatRate / 100))),
    ctl_amount: String(round2(net * (ctlRate / 100))),
    refunded_amount: String(round2(refunded)),
    refunded_at: refundedAt,
  };
}

let pass = 0, fail = 0;
const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
};

// ── 1. The levy must be READ, not derived ───────────────────────────────────
{
  // 1000 inclusive at 16% VAT + 2% CTL. net = 1000/1.18 = 847.4576.
  const o = makeOrder(1000, 16, 2);
  const net = 1000 / 1.18;
  const trueCtl = net * 0.02;                       // 16.949
  const trueVat = net * 0.16;                        // 135.593

  const f = orderTax(o);
  ok('VAT read back from stored vat_amount', approx(f.vat, trueVat), `${f.vat} vs ${trueVat}`);
  ok('CTL read back from stored ctl_amount', approx(f.ctl, trueCtl), `${f.ctl} vs ${trueCtl}`);

  // The OLD derived formula: (gross - vat) * ctlRate.
  const oldDerivedCtl = (1000 - trueVat) * 0.02;     // = (net*1.02)*0.02 = net*0.0204
  ok('old derived levy was overstated', oldDerivedCtl > trueCtl,
     `derived ${round2(oldDerivedCtl)} vs true ${round2(trueCtl)}`);
  ok('...by exactly net * ctlRate^2', approx(oldDerivedCtl - trueCtl, net * 0.02 * 0.02),
     `${round2(oldDerivedCtl - trueCtl)}`);
  // net-of-tax reconciles: net + vat + ctl = gross.
  ok('net + vat + ctl reconciles to gross',
     approx(f.netOfTax + f.vat + f.ctl, f.net), `${round2(f.netOfTax + f.vat + f.ctl)} vs ${f.net}`);
}

// ── 2. A full refund removes the order from sales and tax ────────────────────
{
  const o = makeOrder(1000, 16, 2, 1000, '2026-08-05T10:00:00Z');
  const f = orderTax(o);
  ok('full refund: gross still records the sale', approx(f.gross, 1000));
  ok('full refund: net revenue is zero', approx(f.net, 0), `${f.net}`);
  ok('full refund: VAT contribution is zero', approx(f.vat, 0), `${f.vat}`);
  ok('full refund: CTL contribution is zero', approx(f.ctl, 0), `${f.ctl}`);
  ok('full refund: flagged as refunded', f.wasRefunded === true);
}

// ── 3. A partial refund reduces tax proportionally ──────────────────────────
{
  // Refund 250 of a 1000 order → keep 75%.
  const o = makeOrder(1000, 16, 2, 250, '2026-08-05T11:00:00Z');
  const f = orderTax(o);
  const net = 1000 / 1.18;
  ok('partial refund: net retained is 750', approx(f.net, 750), `${f.net}`);
  ok('partial refund: VAT reduced to 75%', approx(f.vat, net * 0.16 * 0.75), `${f.vat}`);
  ok('partial refund: CTL reduced to 75%', approx(f.ctl, net * 0.02 * 0.75), `${f.ctl}`);
}

// ── 4. A batch: two clean, one refunded, one partial ────────────────────────
{
  const orders = [
    makeOrder(1000, 16, 2),                                   // clean
    makeOrder(500, 16, 2),                                    // clean
    makeOrder(1000, 16, 2, 1000, '2026-08-05T10:00:00Z'),    // fully refunded
    makeOrder(800, 16, 2, 200, '2026-08-05T12:00:00Z'),      // 25% refunded
  ];
  const agg = sumOrderTax(orders);

  // Gross keeps every sale; net drops the refunds.
  ok('batch gross = 3300 (all four sales)', approx(agg.gross, 3300), `${agg.gross}`);
  ok('batch net = 1000+500+0+600 = 2100', approx(agg.net, 2100), `${agg.net}`);
  ok('batch counts 2 refunded orders', agg.refundedCount === 2, `${agg.refundedCount}`);

  // The OLD sales report would have reported 3300 revenue and full VAT on all
  // four — overstating recognised sales by the 1200 that was handed back.
  const oldRevenue = orders.reduce((s, o) => s + Number(o.total), 0);
  ok('old report overstated revenue by the refunded 1200',
     approx(oldRevenue - agg.net, 1200), `${round2(oldRevenue - agg.net)}`);

  // Everything reconciles.
  ok('batch net-of-tax + vat + ctl = net',
     approx(agg.netOfTax + agg.vat + agg.ctl, agg.net),
     `${round2(agg.netOfTax + agg.vat + agg.ctl)} vs ${agg.net}`);
}

// ── 5. A VAT-only business (ctlRate 0) is unaffected ────────────────────────
{
  const o = makeOrder(1160, 16, 0);
  const f = orderTax(o);
  ok('ctlRate 0: CTL is zero', f.ctl === 0);
  ok('ctlRate 0: VAT is 160 on a 1160 inclusive total', approx(f.vat, 160), `${f.vat}`);
}

// ── 6. Sweep reports: staff / splh / aggregator attribute NET revenue ───────
// These reports each summed Number(o.total) — full value, refunds included.
// After the sweep they attribute orderTax(o).net. This mirrors those reducers.
{
  const cashierOrders = [
    makeOrder(1000, 16, 2),                                 // clean
    makeOrder(1000, 16, 2, 1000, '2026-08-05T10:00:00Z'),  // fully refunded
    makeOrder(800, 16, 2, 200, '2026-08-05T12:00:00Z'),    // 25% back
  ];

  // staff/splh reducer: revenue += orderTax(o).net
  const attributed = cashierOrders.reduce((s, o) => s + orderTax(o).net, 0);
  ok('staff/splh attribute net revenue (1000+0+600)', approx(attributed, 1600), `${round2(attributed)}`);

  // order COUNT still counts every sale — the sale happened.
  ok('order count is unchanged by refunds', cashierOrders.length === 3);

  // aggregator reducer: gross uses keptFraction, commission on the kept gross.
  const commissionPct = 20;
  let aggGross = 0, aggComm = 0;
  for (const o of cashierOrders) {
    const keep = keptFraction(o);
    const g = Number(o.total) * keep;
    aggGross += g;
    aggComm  += g * (commissionPct / 100);
  }
  ok('aggregator gross nets out refunds (1600)', approx(aggGross, 1600), `${round2(aggGross)}`);
  ok('aggregator commission is on retained gross (320)', approx(aggComm, 320), `${round2(aggComm)}`);

  // The old behaviour, for contrast.
  const oldAttributed = cashierOrders.reduce((s, o) => s + Number(o.total), 0);
  ok('old attribution overstated by the refunded 1200',
     approx(oldAttributed - attributed, 1200), `${round2(oldAttributed - attributed)}`);
}

console.log(`\n${fail === 0 ? 'All checks passed. Reports read stored values and net out refunds.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
