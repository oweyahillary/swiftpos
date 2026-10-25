// The petrol till (EXTRA=petrol.js): the pump grid. FUEL=1 opens Pump 3 and picks KES 2,000 (FUEL=panel stops there);
// FUEL=sale adds it to the sale, then scans two shop items (Engine Oil 1L, Water 1L) and goes back to the pumps.
module.exports = async (p) => {
  await require('./s-login.cjs')(p);
  await p.waitForTimeout(500);
  if (!process.env.FUEL) return;
  await p.getByText('Pump 3', { exact: true }).first().click();
  await p.waitForTimeout(400);
  await p.getByRole('button', { name: /2,000/ }).first().click();
  await p.waitForTimeout(300);
  if (process.env.FUEL !== 'sale') return;
  await p.getByRole('button', { name: /Add to sale/ }).first().click();
  await p.waitForTimeout(400);
  await p.getByRole('button', { name: /Shop items/ }).first().click();
  await p.waitForTimeout(500);
  // On the petrol till the shop items are scanned (the grid behind "Shop items" lists the fuel grades): Engine Oil 1L
  // and Water 1L by their barcodes, typed as fast as a scanner would.
  for (const code of ['6161200000004', '6161200000007']) { await p.keyboard.type(code, { delay: 5 }); await p.keyboard.press('Enter'); await p.waitForTimeout(400); }
  await p.getByRole('button', { name: /Pumps/ }).first().click();
  await p.waitForTimeout(400);
};
