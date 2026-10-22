module.exports = async (p) => {
  await require('./s-login.cjs')(p);
  await p.getByRole('button', { name: 'Close', exact: true }).first().click();
  await p.waitForTimeout(800);
  const t = p.getByRole('button', { name: /Close Day/ }).first(); if (await t.count()) { await t.click(); await p.waitForTimeout(900); }
};
