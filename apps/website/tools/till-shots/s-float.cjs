module.exports = async (p) => { await require('./s-login.cjs')(p); await p.getByPlaceholder('0.00').first().fill('2000'); await p.waitForTimeout(300); };
