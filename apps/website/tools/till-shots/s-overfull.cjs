module.exports = async (p) => { await require('./s-login.cjs')(p); await p.waitForTimeout(800); await p.mouse.wheel(0, 2000); await p.waitForTimeout(600); };
