module.exports = async (p) => { for (const k of ['1', '2', '3']) await p.getByRole('button', { name: k, exact: true }).click(); await p.waitForTimeout(300); };
