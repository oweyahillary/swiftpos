module.exports = async (p) => { await require('./s-login.cjs')(p); await p.waitForTimeout(800); };
