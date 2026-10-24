// The minimart till (EXTRA=shop.js): the Groceries tab, a few items, then Beef weighed on the keypad (0.640 kg).
// KEEP_MODAL=1 stops with the weight keypad open.
module.exports = async (p) => {
  await require('./s-login.cjs')(p);
  const tab = p.getByText('Groceries', { exact: true }).first();
  if (await tab.count()) { await tab.click(); await p.waitForTimeout(500); }
  const add = async (name, k = 1) => { for (let i = 0; i < k; i++) { await p.getByText(name, { exact: true }).first().click(); await p.waitForTimeout(250); } };
  await add('Fresh Milk 500ml', 2);
  await add('White Bread 400g');
  await add('Maize Flour 2kg');
  await add('Eggs (tray of 30)');
  await add('Beef (per kg)');
  await p.waitForTimeout(500);
  for (const k of ['0', '.', '6', '4', '0']) await p.keyboard.press(k);
  await p.waitForTimeout(300);
  if (process.env.KEEP_MODAL) return;
  await p.getByTestId('weight-add').click();
  await p.waitForTimeout(400);
};
