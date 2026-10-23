const { chromium } = require('playwright-core');
const path = require('path');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe') });
  const p = await b.newPage({ viewport: { width: Number(process.env.W || 390), height: 844 } });
  await p.goto('http://localhost:4329' + (process.argv[2] || '/'), { waitUntil: 'networkidle' });
  const r = await p.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > document.documentElement.clientWidth + 1; }).slice(0, 6).map((e) => { const a = []; let x = e; while (x && x !== document.body) { a.unshift(x.tagName + (x.className && typeof x.className === 'string' ? '.' + x.className.split(' ')[0] : '')); x = x.parentElement; } return a.join('>') + ' ' + Math.round(e.getBoundingClientRect().right); }));
  console.log(r.join('\n'));
  await b.close();
})();
