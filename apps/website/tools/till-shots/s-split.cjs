module.exports = async (p) => {
  await require('./s-pay.cjs')(p);
  await p.getByText('+ Split payment').click(); await p.waitForTimeout(500);
  const amt = p.locator('.fixed input').filter({ hasNot: p.locator('[placeholder*="QHX"]') });
  const inputs = p.locator('.fixed input');
  const n = await inputs.count();
  const vals = []; for (let i = 0; i < n; i++) vals.push(await inputs.nth(i).getAttribute('placeholder'));
  console.log('inputs', JSON.stringify(vals));
  await inputs.nth(0).fill('1050'); await inputs.nth(1).fill('1050');
  await inputs.nth(2).fill('2000');
  await p.waitForTimeout(400);
};
