module.exports = async (p) => {
  await require('./s-closeday.cjs')(p);
  await p.getByRole('button', { name: 'Close Branch', exact: true }).click(); await p.waitForTimeout(1200);
};
