// node run.cjs '<scenario json>' <out.png|-> [steps.cjs]
const { chromium } = require('playwright-core');
const path = require('path'); const fs = require('fs');
const exe = process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
(async () => {
  const [scenario, out, stepsFile] = process.argv.slice(2);
  const W = Number(process.env.W || 1280), H = Number(process.env.H || 800);
  const b = await chromium.launch({ executablePath: exe });
  const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: Number(process.env.DPR || 1) });
  const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  if (process.env.AT) await p.clock.setFixedTime(new Date(process.env.AT));
  await p.addInitScript(`window.__SCENARIO = ${scenario || '{}'};`);
  await p.addInitScript({ path: path.join(__dirname, 'mock.js') });
  if (fs.existsSync(path.join(__dirname, 'extra.js'))) await p.addInitScript({ path: path.join(__dirname, 'extra.js') });
  await p.addInitScript({ path: path.join(__dirname, 'preload.bundle.js') });
  await p.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  if (stepsFile) await require(path.resolve(__dirname, stepsFile))(p);
  await p.waitForTimeout(500);
  if (out && out !== '-') { if (process.env.EL) await p.locator(process.env.EL).first().screenshot({ path: path.join(__dirname, out) }); else await p.screenshot({ path: path.join(__dirname, out) }); }
  console.log('unknown:', JSON.stringify(await p.evaluate(() => [...window.__unknown])));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
