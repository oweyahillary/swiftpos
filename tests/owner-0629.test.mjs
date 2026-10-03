/**
 * owner-0629.test.mjs — 0.6.29: the owner's points after testing 0.6.27 / 0.6.28 (2026-10-01).
 *   - "cashiers should never see this only the manager should" + the confirm table → blind close and the cashier's
 *     figures at confirm are STANDARD (shared/posFeatures.ts STANDARD_POS_FEATURES), and the confirm screen is one table
 *     (cashier, shift open–close; per method: cashier, manager, reason) on the till, the web POS and the dashboard;
 *   - "it should show everything of the days sales" → History is today's sales, all of them (till and web);
 *   - D2 "where is the 400 accounted" → History shows what was PAID (bill + tip + delivery fee);
 *   - the after-payment receipt view → a success screen with no print button (till).
 * Source assertions on the screens (React), the shared rule run for real.
 *
 * MUTATIONS TO CONFIRM BITE: History back to the last 30 → "today, all of it" fails; the paid amount without the fee →
 * "what was paid" fails; a confirm screen without the table → "one table" fails; blind close a switch again →
 * "standard" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const F = await import(pathToFileURL(path.join(ROOT, 'shared/posFeatures.ts')).href);

await ok('blind close and the cashier\'s figures are standard: always on, not listed as switches, a stored "off" ignored', () => {
  const f = F.parsePosFeatures([{ key: 'blind_shift_close', enabled: false }, { key: 'confirm_shows_cashier_figures', enabled: false }]);
  assert.equal(f.blind_shift_close, true); assert.equal(f.confirm_shows_cashier_figures, true);
  assert.ok(!F.POS_FEATURES.some((x) => x.key === 'blind_shift_close' || x.key === 'confirm_shows_cashier_figures'));
});
await ok('one table at confirm — cashier, shift open–close; per method: cashier, manager, reason (till, web POS, dashboard)', () => {
  for (const p of ['apps/desktop/src/renderer/components/ConfirmShiftModal.tsx', 'apps/dashboard/src/pages/pos/ShiftModal.tsx',
                   'apps/dashboard/src/components/ShiftConfirmations.tsx']) {
    const s = read(p);
    assert.match(s, /data-testid="confirm-head"/, p);
    assert.match(s, /data-testid="confirm-table"/, p);
    assert.match(s, />Cashier<\/th>\}/, p);
    assert.match(s, />Manager( \(\{currency\}\))?<\/th>/, p);
    assert.match(s, /data-testid=\{`reason-\$\{(c|m)\}`\}/, p);
  }
  const till = read('apps/desktop/src/renderer/components/ConfirmShiftModal.tsx');
  assert.match(till, /\{when\(openedAt\)\} – \{closedAt \? when\(closedAt\) : 'open'\}/);
  assert.match(read('apps/desktop/src/renderer/pages/DayCloseTab.tsx'), /openedAt=\{confirmingShift\.opened_at\} closedAt=\{confirmingShift\.closed_at\}/);
  assert.match(read('apps/desktop/src/renderer/pages/ShiftPanel.tsx'), /openedAt=\{finalReport\.shift\.opened_at\} closedAt=\{finalReport\.shift\.closed_at\}/);
});
await ok('History is today\'s sales, all of it (till and web)', () => {
  assert.match(read('apps/desktop/src/main/ipcHandlers.ts'), /orders: getRecentOrders\(0, resolveRange\('today'\), scope\.ownOnly \? scope\.staffId : null\)/);
  const web = read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx');
  assert.match(web, /const dayStart = new Date\(new Date\(by, bm - 1, bd, 0, 0, 0, 0\)\.getTime\(\) \+ cut \* 60_000\);\s*params\.set\('date_from', dayStart\.toISOString\(\)\);/);   // 0.6.34: from the business day's start
});
await ok('History shows what was paid — the bill + tip + delivery fee (till and web; the cloud sends the tip)', () => {
  // 0.6.33: the delivery fee the CUSTOMER paid — none on a free delivery (the shop paid the rider).
  assert.match(read('apps/desktop/src/renderer/pages/POSPage.tsx'), /fmtMoney\(Number\(o\.total\) \+ Number\(o\.tip_amount \?\? 0\) \+ customerDeliveryFee\(o\.delivery_fee, o\.delivery_free\)\)/);
  assert.match(read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx'), /Number\(o\.total\) \+ Number\(o\.tip_amount \?\? 0\) \+ customerDeliveryFee\(o\.delivery_fee, o\.delivery_free\)/);
  assert.match(read('apps/server/src/routes/orders.ts'), /cashier_id, delivery_person, delivery_fee, delivery_free, tip_amount,\n\s+payments \( method, amount, status \)/);
});
await ok('after payment: a success screen, no print button (till)', () => {
  const pos = read('apps/desktop/src/renderer/pages/POSPage.tsx');
  assert.match(pos, /data-testid="payment-success"/);
  assert.ok(!/Print receipt/.test(pos) && !/ReceiptView/.test(pos));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
