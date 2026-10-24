// Video states for the restaurant clip (mock.js: Mama Lishe Grill): Table 4's order, a variant on the line, sent to the
// kitchen. CLIP=<dir> gets grill-NN.png and grill.json ([{ file, tap, note }], x/y in the 1280 x 800 screen).
const fs = require('fs'); const path = require('path');
module.exports = async (p) => {
  const dir = process.env.CLIP; fs.mkdirSync(dir, { recursive: true });
  const states = []; let n = 0;
  const shot = async (note, tap = null) => { const file = `grill-${String(n++).padStart(2, '0')}.png`; await p.waitForTimeout(350); await p.screenshot({ path: path.join(dir, file) }); states.push({ file, tap, note }); };
  const centre = async (loc) => { const b = await loc.boundingBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; };
  const tap = async (loc, note) => { const c = await centre(loc); await loc.click(); await shot(note, c); };
  await require('./s-login.cjs')(p);
  await shot('tables');
  await tap(p.getByText('T4', { exact: true }).first(), 'table 4');
  await tap(p.getByText('Nyama Choma 1kg', { exact: true }).first(), 'nyama');
  for (let i = 0; i < 2; i++) {
    await tap(p.getByText('Chips Masala', { exact: true }).first(), 'chips');
    await tap(p.getByRole('button', { name: /^Spicy/ }).first(), 'spicy');
    await tap(p.locator('.fixed button').last(), 'add');
  }
  await tap(p.getByText('Chicken Burger', { exact: true }).first(), 'burger');
  await tap(p.getByRole('button', { name: /^Spicy/ }).first(), 'spicy');
  await tap(p.locator('.fixed button').last(), 'add');
  await tap(p.getByText('Kachumbari', { exact: true }).first(), 'kachumbari');
  await tap(p.getByText('Passion Juice', { exact: true }).first(), 'juice');
  await tap(p.getByText('Passion Juice', { exact: true }).first(), 'juice');
  const send = p.getByRole('button', { name: /Send to kitchen/ }).first();
  const c = await centre(send);
  await shot('before send', c);
  fs.writeFileSync(path.join(dir, 'grill.json'), JSON.stringify(states, null, 1));
};
