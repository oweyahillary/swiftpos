// Video states for the shop clip (EXTRA=shop.js): each step of a Kijani Basket sale as a still, with where the tap lands.
// CLIP=<dir> gets shop-NN.png and shop.json ([{ file, tap: {x, y} | null, note }], x/y in the 1280 x 800 screen).
const fs = require('fs'); const path = require('path');
module.exports = async (p) => {
  const dir = process.env.CLIP; fs.mkdirSync(dir, { recursive: true });
  const states = []; let n = 0;
  const shot = async (note, tap = null) => { const file = `shop-${String(n++).padStart(2, '0')}.png`; await p.waitForTimeout(350); await p.screenshot({ path: path.join(dir, file) }); states.push({ file, tap, note }); };
  const centre = async (loc) => { const b = await loc.boundingBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; };
  const tap = async (loc, note) => { const c = await centre(loc); await loc.click(); await shot(note, c); };
  await require('./s-login.cjs')(p);
  const tab = p.getByText('Groceries', { exact: true }).first();
  await tab.click(); await p.waitForTimeout(400);
  await shot('start');
  for (const name of ['Fresh Milk 500ml', 'Fresh Milk 500ml', 'White Bread 400g', 'Maize Flour 2kg', 'Eggs (tray of 30)']) {
    await tap(p.getByText(name, { exact: true }).first(), 'scan ' + name);
  }
  await tap(p.getByText('Beef (per kg)', { exact: true }).first(), 'weigh');
  const modal = p.getByTestId('weight-modal');
  for (const k of ['0', '.', '6', '4', '0']) await tap(modal.getByRole('button', { name: k, exact: true }).first(), 'key ' + k);
  await tap(p.getByTestId('weight-add'), 'added');
  await tap(p.getByRole('button', { name: /Charge KES/ }).first(), 'pay');
  await tap(p.locator('.fixed button').filter({ hasText: /M-?Pesa/i }).first(), 'mpesa');
  fs.writeFileSync(path.join(dir, 'shop.json'), JSON.stringify(states, null, 1));
};
