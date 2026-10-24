// Video states for the petrol clip (EXTRA=petrol.js: Kifaru Fuel & Mart): Pump 3, KES 2,000 of diesel, two shop items
// scanned. CLIP=<dir> gets fuel-NN.png and fuel.json ([{ file, tap, note }], x/y in the 1280 x 800 screen).
const fs = require('fs'); const path = require('path');
module.exports = async (p) => {
  const dir = process.env.CLIP; fs.mkdirSync(dir, { recursive: true });
  const states = []; let n = 0;
  const shot = async (note, tap = null) => { const file = `fuel-${String(n++).padStart(2, '0')}.png`; await p.waitForTimeout(350); await p.screenshot({ path: path.join(dir, file) }); states.push({ file, tap, note }); };
  const centre = async (loc) => { const b = await loc.boundingBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; };
  const tap = async (loc, note) => { const c = await centre(loc); await loc.click(); await shot(note, c); };
  await require('./s-login.cjs')(p);
  await shot('pumps');
  await tap(p.getByText('Pump 3', { exact: true }).first(), 'pump 3');
  await tap(p.getByRole('button', { name: /2,000/ }).first(), '2000');
  await tap(p.getByRole('button', { name: /Add to sale/ }).first(), 'add');
  await tap(p.getByRole('button', { name: /Shop items/ }).first(), 'shop items');
  for (const code of ['6161200000004', '6161200000007']) { await p.keyboard.type(code, { delay: 5 }); await p.keyboard.press('Enter'); await shot('scan ' + code); }
  await tap(p.getByRole('button', { name: /Pumps/ }).first(), 'back');
  fs.writeFileSync(path.join(dir, 'fuel.json'), JSON.stringify(states, null, 1));
};
