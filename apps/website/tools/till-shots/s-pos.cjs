module.exports = async (p) => {
  await require('./s-login.cjs')(p);
  await p.getByText('T4', { exact: true }).first().click();
  await p.waitForTimeout(800);
  const add = async (name, n = 1) => { for (let i = 0; i < n; i++) { await p.getByText(name, { exact: true }).first().click(); await p.waitForTimeout(250); } };
  const pick = async (name, opt, qty = 1) => {
    await add(name); await p.waitForTimeout(300);
    await p.getByRole('button', { name: new RegExp('^' + opt) }).click(); await p.waitForTimeout(150);
    await p.locator('.fixed button').last().click(); await p.waitForTimeout(400);
  };
  await add('Nyama Choma 1kg');
  await pick('Chips Masala', 'Spicy');
  await pick('Chicken Burger', 'Spicy');
  await add('Kachumbari');
  await add('Passion Juice', 2);
};
