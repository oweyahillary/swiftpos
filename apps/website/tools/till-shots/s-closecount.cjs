module.exports = async (p) => {
  await require('./s-closeday.cjs')(p);
  await p.getByPlaceholder('0.00').first().fill('24150'); await p.waitForTimeout(200);
  const s = p.getByText(/Show expected cash/).first(); if (await s.count()) { await s.click(); await p.waitForTimeout(500); }
};
