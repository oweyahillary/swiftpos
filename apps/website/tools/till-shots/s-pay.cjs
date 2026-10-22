module.exports = async (p) => { await require('./s-pos.cjs')(p); await p.getByRole('button', { name: /Charge/ }).click(); await p.waitForTimeout(900); };
